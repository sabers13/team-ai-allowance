/**
 * Member MCP tools. Each tool calls the
 * control-service API and answers with short plain text plus structured
 * content. A domain refusal (over budget, unknown request) is a normal
 * result with `isError: true`, never a thrown exception.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { IsoDateTime, Request, RequestState } from "../contracts.ts";
import { type ApiClient, ApiError, sumSpend } from "./api.ts";
import { findHint, type HintsFile } from "./hints.ts";
import { allowanceView, formatAllowance, formatRequests } from "./text.ts";

const emptySchema = z.object({});
const stateSchema = z.enum([
  "pending",
  "approved",
  "partly_approved",
  "denied",
  "expired",
  "cancelled",
]);

const allowanceOutput = z.object({
  remainingUsd: z.number(),
  budgetUsd: z.number(),
  spendUsd: z.number(),
  status: z.string(),
  periodEndsAt: z.string().nullable(),
  allowedModels: z.array(z.string()),
});

const requestOutput = z.object({
  id: z.string(),
  kind: z.string(),
  amountUsd: z.number().nullable(),
  modelId: z.string().nullable(),
  message: z.string(),
  state: z.string(),
  createdAt: z.string(),
});

function requestSummary(request: Request): Record<string, unknown> {
  return {
    id: request.id,
    kind: request.kind,
    amountUsd: request.amountUsd,
    modelId: request.modelId,
    message: request.message,
    state: request.state,
    createdAt: request.createdAt,
  };
}

function ok(text: string, structured: unknown): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function refused(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Turn an API failure into a sentence the member can act on. No secrets. */
export function apiFailure(error: unknown): CallToolResult {
  if (error instanceof ApiError) {
    if (error.isNetwork())
      return refused("Cannot reach the control service. Try again in a minute.");
    return refused(error.message);
  }
  return refused("Something went wrong. Try again in a minute.");
}

function usageWindowDays(period: string): number {
  if (period === "daily") return 1;
  if (period === "monthly") return 30;
  return 7;
}

async function currentSpend(
  api: ApiClient,
  me: { limits?: { period?: string }; spendUsd?: unknown },
): Promise<number> {
  if (typeof me.spendUsd === "number") return me.spendUsd;
  const days = usageWindowDays(me.limits?.period ?? "weekly");
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await api.myUsage(from.toISOString(), to.toISOString());
  return sumSpend(rows);
}

export interface MemberToolDeps {
  readonly api: ApiClient;
  readonly hints?: HintsFile | undefined;
}

function isoDate(value: string): IsoDateTime | null {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

/** Register the seven member tools on a server. */
export function registerMemberTools(server: McpServer, deps: MemberToolDeps): void {
  const { api } = deps;
  const hints = deps.hints ?? { hints: [] };

  server.registerTool(
    "my_allowance",
    {
      title: "My allowance",
      description: "Remaining budget, status and allowed models for the current member.",
      inputSchema: emptySchema,
      outputSchema: allowanceOutput,
    },
    async () => {
      try {
        const me = await api.getMe();
        const spend = await currentSpend(api, me);
        const view = allowanceView(me, spend);
        return ok(formatAllowance(view), {
          remainingUsd: view.remainingUsd,
          budgetUsd: view.budgetUsd,
          spendUsd: view.spendUsd,
          status: view.status,
          periodEndsAt: view.periodEndsAt,
          allowedModels: view.allowedModels,
        });
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "allowed_models",
    {
      title: "Allowed models",
      description: "Model ids the current member may use right now.",
      inputSchema: emptySchema,
      outputSchema: z.object({
        models: z.array(z.object({ id: z.string(), displayName: z.string(), state: z.string() })),
      }),
    },
    async () => {
      try {
        const me = await api.getMe();
        const models = me.allowedModels.map((id) => ({ id, displayName: id, state: "enabled" }));
        const text =
          models.length > 0 ? models.map((model) => model.id).join("\n") : "No models allowed.";
        return ok(text, { models });
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "request_more_budget",
    {
      title: "Request more budget",
      description: "Ask the manager for extra budget, with a reason.",
      inputSchema: z.object({
        amountUsd: z.number().positive(),
        until: z.string().optional(),
        reason: z.string().min(1),
      }),
      outputSchema: requestOutput,
    },
    async ({ amountUsd, until, reason }) => {
      try {
        let message = reason;
        if (until !== undefined) {
          const parsed = isoDate(until);
          if (parsed === null) return refused(`"${until}" is not a date I understand.`);
          message = `${reason} (requested until ${parsed.slice(0, 10)})`;
        }
        const request = await api.createRequest({ kind: "more_budget", amountUsd, message });
        return ok("Request sent to your manager.", requestSummary(request));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "request_model",
    {
      title: "Request a model",
      description: "Ask the manager to unlock a model, with a reason.",
      inputSchema: z.object({
        modelId: z.string().min(1),
        hours: z.number().positive().optional(),
        reason: z.string().min(1),
      }),
      outputSchema: requestOutput,
    },
    async ({ modelId, hours, reason }) => {
      try {
        const message = hours === undefined ? reason : `${reason} (requested for ${hours} hours)`;
        const request = await api.createRequest({ kind: "model_unlock", modelId, message });
        const hint = findHint(hints, modelId);
        const text =
          hint !== null && hint.instead.length > 0
            ? `Request sent; a cheaper option is ${hint.instead.join(", ")}.`
            : "Request sent to your manager.";
        return ok(text, requestSummary(request));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "send_suggestion",
    {
      title: "Send a suggestion",
      description: "Send a note to the manager. No budget or model attached.",
      inputSchema: z.object({ message: z.string().min(1) }),
      outputSchema: requestOutput,
    },
    async ({ message }) => {
      try {
        const request = await api.createRequest({ kind: "suggestion", message });
        return ok("Noted for your manager.", requestSummary(request));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "my_requests",
    {
      title: "My requests",
      description: "List the current member's requests, newest first.",
      inputSchema: z.object({
        state: stateSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
      outputSchema: z.object({ requests: z.array(requestOutput) }),
    },
    async ({ state, limit }) => {
      try {
        let requests = await api.listMyRequests();
        if (state !== undefined)
          requests = requests.filter((r) => (r.state as RequestState) === state);
        if (limit !== undefined) requests = requests.slice(0, limit);
        return ok(formatRequests(requests), { requests: requests.map(requestSummary) });
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "cancel_request",
    {
      title: "Cancel a request",
      description: "Withdraw a pending request.",
      inputSchema: z.object({ requestId: z.string().min(1) }),
      outputSchema: requestOutput,
    },
    async ({ requestId }) => {
      try {
        const request = await api.cancelRequest(requestId);
        return ok("Request cancelled.", requestSummary(request));
      } catch (error) {
        return apiFailure(error);
      }
    },
  );
}
