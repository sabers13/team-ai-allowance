/**
 * Manager MCP tools. Same result contract as the
 * member tools: short plain text plus structured content, refusals as
 * `isError: true` results.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { inferCli } from "../console/usage/inference.ts";
import type { ApiFormat, RequestState, UsageRow } from "../contracts.ts";
import type { ApiClient } from "./api.ts";
import { apiFailure } from "./member-tools.ts";
import { formatRequests, formatUsd, summarizeUsage } from "./text.ts";

const stateSchema = z.enum([
  "pending",
  "approved",
  "partly_approved",
  "denied",
  "expired",
  "cancelled",
]);
const outcomeSchema = z.enum(["approved", "partly_approved", "denied"]);
const periodSchema = z.enum(["daily", "weekly", "monthly"]);

const decisionOutput = z.object({
  request: z.object({ id: z.string(), state: z.string() }).passthrough(),
  decision: z.object({ outcome: z.string() }).passthrough(),
  grant: z.unknown(),
});

function describeDecision(
  outcome: string,
  note: string | undefined,
  amountUsd: number | undefined,
  until: string | undefined,
): string {
  if (outcome === "denied") {
    return note !== undefined && note !== "" ? `Denied. ${note}` : "Denied.";
  }
  const head = outcome === "partly_approved" ? "Partly approved" : "Approved";
  const amount = amountUsd === undefined ? "" : ` ${formatUsd(amountUsd)}`;
  const date = until === undefined ? "" : ` until ${until.slice(0, 10)}`;
  const tail = note !== undefined && note !== "" ? ` Note: ${note}` : "";
  return `${head}${amount}${date}.${tail}`;
}

type UsagePeriodArg = "today" | "7d" | "30d" | "custom";

interface UsageWindow {
  from: string;
  to: string;
  label: string;
}

function usageWindow(
  period: UsagePeriodArg,
  fromRaw: string | undefined,
  toRaw: string | undefined,
): UsageWindow | null {
  const now = new Date();
  if (period === "custom") {
    if (fromRaw === undefined || toRaw === undefined) return null;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const from = new Date(dateOnly.test(fromRaw) ? `${fromRaw}T00:00:00.000Z` : fromRaw);
    const to = new Date(dateOnly.test(toRaw) ? `${toRaw}T23:59:59.999Z` : toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    if (from.getTime() > to.getTime()) return null;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      label: `${fromRaw.slice(0, 10)} to ${toRaw.slice(0, 10)}`,
    };
  }
  if (period === "today") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    return { from: start.toISOString(), to: now.toISOString(), label: "today (UTC)" };
  }
  const days = period === "7d" ? 7 : 30;
  return {
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
    label: `the last ${days} days`,
  };
}

interface TeamUsageMember {
  memberId: string;
  displayName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  topModel: string;
  cli: string;
  cliInferred: true;
  apiFormat: ApiFormat;
}

function usageByMember(
  members: Array<{ member: { id: string; displayName: string } }>,
  rows: readonly UsageRow[],
): TeamUsageMember[] {
  return members.map((entry) => {
    const memberRows = rows.filter((row) => row.memberId === entry.member.id);
    const formats = new Map<ApiFormat, number>();
    for (const row of memberRows) {
      const format = row.apiFormat ?? "unknown";
      formats.set(format, (formats.get(format) ?? 0) + 1);
    }
    let best: ApiFormat = "unknown";
    let bestCount = -1;
    for (const format of [
      "anthropic_messages",
      "responses",
      "chat_completions",
      "unknown",
    ] as const) {
      const count = formats.get(format) ?? 0;
      if (count > bestCount) {
        best = format;
        bestCount = count;
      }
    }
    const top = summarizeUsage(memberRows)[0];
    return {
      memberId: entry.member.id,
      displayName: entry.member.displayName,
      requests: memberRows.length,
      inputTokens: memberRows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: memberRows.reduce((sum, row) => sum + row.outputTokens, 0),
      costUsd: memberRows.reduce((sum, row) => sum + row.costUsd, 0),
      topModel: top?.modelId ?? "—",
      cli: inferCli(best).label,
      cliInferred: true,
      apiFormat: best,
    };
  });
}

/** Register the seven manager tools on a server. */
export function registerManagerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "team_overview",
    {
      title: "Team overview",
      description: "Spend, budget, blocked members and pending requests for the team.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        team: z.object({ id: z.string(), name: z.string() }).passthrough(),
        spendUsd: z.number(),
        budgetUsd: z.number(),
        members: z.array(z.unknown()),
        pendingRequests: z.array(z.unknown()),
      }),
    },
    async () => {
      try {
        const overview = await api.teamOverview();
        const spendUsd = overview.members.reduce((total, entry) => total + entry.spendUsd, 0);
        const blocked = overview.members.filter(
          (entry) => entry.member.blocked || entry.policy.blocked,
        ).length;
        const pending = overview.openRequests.length;
        const text =
          `Team ${overview.team.name}: ${formatUsd(spendUsd)} spent of ` +
          `${formatUsd(overview.team.monthlyBudgetUsd)} this month. ` +
          `${blocked} blocked, ${pending} pending.`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            team: overview.team,
            spendUsd,
            budgetUsd: overview.team.monthlyBudgetUsd,
            members: overview.members,
            pendingRequests: overview.openRequests,
          },
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "team_usage",
    {
      title: "Team usage",
      description: "Requests, tokens, spend, top models and inferred CLI per member for a period.",
      inputSchema: z.object({
        period: z.enum(["today", "7d", "30d", "custom"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      outputSchema: z.object({
        period: z.string(),
        from: z.string(),
        to: z.string(),
        totals: z.object({
          requests: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          costUsd: z.number(),
        }),
        members: z.array(
          z.object({
            memberId: z.string(),
            displayName: z.string(),
            requests: z.number(),
            inputTokens: z.number(),
            outputTokens: z.number(),
            costUsd: z.number(),
            topModel: z.string(),
            cli: z.string(),
            cliInferred: z.literal(true),
            apiFormat: z.string(),
          }),
        ),
        byModel: z.array(
          z.object({
            modelId: z.string(),
            requests: z.number(),
            costUsd: z.number(),
          }),
        ),
      }),
    },
    async ({ period, from, to }) => {
      const chosen = period ?? "7d";
      const window = usageWindow(chosen, from, to);
      if (window === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "For a custom period, pass both from and to as YYYY-MM-DD or ISO dates, with from not after to.",
            },
          ],
          isError: true as const,
        };
      }
      try {
        const [overview, rows] = await Promise.all([
          api.teamOverview(),
          api.teamUsage(window.from, window.to),
        ]);
        const members = usageByMember(overview.members, rows);
        const requests = rows.length;
        const costUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
        const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
        const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
        const byModelMap = new Map<string, { requests: number; costUsd: number }>();
        for (const row of rows) {
          const entry = byModelMap.get(row.modelId) ?? { requests: 0, costUsd: 0 };
          entry.requests += 1;
          entry.costUsd += row.costUsd;
          byModelMap.set(row.modelId, entry);
        }
        const byModel = [...byModelMap.entries()]
          .map(([modelId, entry]) => ({ modelId, ...entry }))
          .sort((left, right) => right.costUsd - left.costUsd);
        const cliCounts = new Map<string, number>();
        for (const member of members) {
          if (member.requests === 0) continue;
          cliCounts.set(member.cli, (cliCounts.get(member.cli) ?? 0) + member.requests);
        }
        const cliText = [...cliCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([label, count]) => `${label} ${count}`)
          .join(", ");
        const top = byModel[0];
        const topText = top === undefined ? "" : ` Top: ${top.modelId} ${formatUsd(top.costUsd)}.`;
        const text =
          `Team ${overview.team.name}: ${requests} requests, ${formatUsd(costUsd)}, ` +
          `${inputTokens.toLocaleString("en-US")} in / ${outputTokens.toLocaleString("en-US")} out tokens, ` +
          `${window.label}.${topText}` +
          (cliText === "" ? "" : ` CLI inferred: ${cliText}.`);
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            period: chosen,
            from: window.from,
            to: window.to,
            totals: { requests, inputTokens, outputTokens, costUsd },
            members,
            byModel,
          },
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "list_requests",
    {
      title: "List requests",
      description: "List team requests, optionally filtered by state or member.",
      inputSchema: z.object({
        state: stateSchema.optional(),
        memberId: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
      outputSchema: z.object({ requests: z.array(z.unknown()) }),
    },
    async ({ state, memberId, limit }) => {
      try {
        let requests = await api.teamRequests({ state, memberId, limit });
        if (state !== undefined)
          requests = requests.filter((r) => (r.state as RequestState) === state);
        if (limit !== undefined) requests = requests.slice(0, limit);
        return {
          content: [{ type: "text" as const, text: formatRequests(requests) }],
          structuredContent: { requests },
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "decide_request",
    {
      title: "Decide a request",
      description: "Approve, partly approve or deny a pending request.",
      inputSchema: z.object({
        requestId: z.string().min(1),
        outcome: outcomeSchema,
        note: z.string().optional(),
        amountUsd: z.number().positive().optional(),
        modelId: z.string().optional(),
        until: z.string().optional(),
        permanent: z.boolean().optional(),
      }),
      outputSchema: decisionOutput,
    },
    async ({ requestId, outcome, note, amountUsd, modelId, until, permanent }) => {
      try {
        let parsedUntil: string | undefined;
        if (until !== undefined) {
          const time = Date.parse(until);
          if (Number.isNaN(time)) {
            return {
              content: [{ type: "text" as const, text: `"${until}" is not a date I understand.` }],
              isError: true as const,
            };
          }
          parsedUntil = new Date(time).toISOString();
        }
        const result = await api.decideRequest(requestId, {
          outcome,
          note,
          amountUsd,
          modelId,
          until: parsedUntil,
          permanent,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: describeDecision(outcome, note, amountUsd, parsedUntil),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "set_member_limit",
    {
      title: "Set a member limit",
      description: "Change one member's budget period, token cap or rate limits.",
      inputSchema: z.object({
        memberId: z.string().min(1),
        budgetUsd: z.number().positive().optional(),
        period: periodSchema.optional(),
        tokenCap: z.number().int().positive().optional(),
        rpm: z.number().int().positive().optional(),
        tpm: z.number().int().positive().optional(),
      }),
      outputSchema: z.object({ member: z.unknown(), policy: z.unknown() }),
    },
    async ({ memberId, budgetUsd, period, tokenCap, rpm, tpm }) => {
      try {
        const result = await api.setMemberLimits(memberId, {
          budgetUsd,
          period,
          tokenCap,
          rpm,
          tpm,
        });
        return {
          content: [{ type: "text" as const, text: "Limit updated." }],
          structuredContent: result,
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "set_member_models",
    {
      title: "Set member models",
      description: "Replace one member's allowed model list.",
      inputSchema: z.object({ memberId: z.string().min(1), modelIds: z.array(z.string()) }),
      outputSchema: z.object({ member: z.unknown(), policy: z.unknown() }),
    },
    async ({ memberId, modelIds }) => {
      try {
        const result = await api.setMemberModels(memberId, modelIds);
        return {
          content: [{ type: "text" as const, text: "Models updated." }],
          structuredContent: result,
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );

  server.registerTool(
    "member_usage",
    {
      title: "Member usage",
      description: "Spend and top models for one member over recent days.",
      inputSchema: z.object({
        memberId: z.string().min(1),
        days: z.number().int().positive().max(365).optional(),
      }),
      outputSchema: z.object({
        member: z.unknown(),
        from: z.string(),
        to: z.string(),
        spendUsd: z.number(),
        byModel: z.array(z.object({ modelId: z.string(), spendUsd: z.number() })),
      }),
    },
    async ({ memberId, days }) => {
      try {
        const windowDays = days ?? 30;
        const detail = await api.memberDetail(memberId);
        const to = new Date();
        const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
        const rows = detail.usage.filter((row) => row.at >= from.toISOString());
        const spendUsd = rows.reduce((total, row) => total + row.costUsd, 0);
        const byModel = summarizeUsage(rows);
        const top =
          byModel.length > 0
            ? ` Top: ${byModel.map((entry) => `${entry.modelId} ${formatUsd(entry.spendUsd)}`).join(", ")}.`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `${detail.member.displayName} spent ${formatUsd(spendUsd)} in the last ${windowDays} days.${top}`,
            },
          ],
          structuredContent: {
            member: detail.member,
            from: from.toISOString(),
            to: to.toISOString(),
            spendUsd,
            byModel,
          },
        };
      } catch (error) {
        return apiFailure(error);
      }
    },
  );
}
