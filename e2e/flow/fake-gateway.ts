/**
 * A local stand-in for the LiteLLM proxy, for the e2e flow and the demo.
 *
 * It speaks the slice of the admin API that `src/gateway/client.ts` uses, plus
 * the three model routes the CLIs call (Chat Completions, Responses, Anthropic
 * Messages). It enforces what the real gateway enforces for this project:
 * allowed models per key, the per-key budget, and a blocked key — with the
 * error bodies verified from LiteLLM's open-source proxy ("Error bodies returned to a
 * CLI", so the CLI shows the same sentence it would show in production.
 *
 * One deliberate difference: a model call costs a fixed `callCostUsd` (default
 * USD 0.30) instead of the mock upstream's fraction of a cent. A demo budget of
 * a few dollars then means a handful of calls, and the console shows numbers a
 * person can read. The fake prints nothing and stores no prompt text: it keeps
 * ids, models, tokens and cost only.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeKey {
  alias: string;
  secret: string;
  hash: string;
  models: string[];
  maxBudgetUsd: number;
  budgetDuration: string;
  tpmLimit: number | null;
  rpmLimit: number | null;
  blocked: boolean;
  teamId: string | null;
  userId: string | null;
  spendUsd: number;
}

export interface FakeSpendRow {
  requestId: string;
  keyHash: string;
  teamId: string | null;
  userId: string | null;
  model: string;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: string;
  callType: "chat_completions" | "responses" | "anthropic_messages";
}

export interface FakeGatewayOptions {
  port?: number;
  host?: string;
  /** USD charged per model call. Default 0.30. */
  callCostUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Timestamp source for spend rows; the e2e flow drives a fixed clock. */
  now?: () => Date;
}

export interface FakeGateway {
  url: string;
  port: number;
  keys: Map<string, FakeKey>;
  spend: FakeSpendRow[];
  server: Server;
  reset(): void;
  close(): Promise<void>;
}

export const FAKE_GATEWAY_DEFAULT_PORT = 18091;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function errorBody(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
  param: string | null = null,
): void {
  json(response, status, { error: { message, type, param, code: String(status) } });
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function listOf(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

function spendString(value: number): string {
  return value.toFixed(4);
}

export function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const keys = new Map<string, FakeKey>();
  const spend: FakeSpendRow[] = [];
  const teams = new Map<string, { alias: string; maxBudget: number; models: string[] }>();
  const users = new Map<string, { alias: string | null; email: string | null; teams: string[] }>();
  const callCostUsd = options.callCostUsd ?? 0.3;
  const promptTokens = options.promptTokens ?? 1_200;
  const completionTokens = options.completionTokens ?? 300;
  const now = options.now ?? (() => new Date());
  let requestCounter = 0;

  function findKey(secret: string): FakeKey | null {
    for (const key of keys.values()) if (key.secret === secret) return key;
    return null;
  }

  function findByHash(hash: string): FakeKey | null {
    for (const key of keys.values()) if (key.hash === hash) return key;
    return null;
  }

  function keyRecord(key: FakeKey): Record<string, unknown> {
    return {
      key_alias: key.alias,
      token: key.hash,
      models: key.models,
      max_budget: key.maxBudgetUsd,
      budget_duration: key.budgetDuration,
      tpm_limit: key.tpmLimit,
      rpm_limit: key.rpmLimit,
      blocked: key.blocked,
      team_id: key.teamId,
      user_id: key.userId,
      spend: Number(spendString(key.spendUsd)),
    };
  }

  function issueSecret(): string {
    requestCounter += 1;
    return `sk-fake-${requestCounter}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function modelCall(request: IncomingMessage, response: ServerResponse, route: string): void {
    const authorization = request.headers.authorization ?? "";
    const secret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const key = secret === "" ? null : findKey(secret);
    if (key === null) {
      errorBody(response, 401, "auth_error", "Authentication Error: invalid proxy server token.");
      return;
    }
    if (key.blocked) {
      errorBody(
        response,
        403,
        "auth_error",
        "Authentication Error: this key is blocked. Ask your team manager to unblock it.",
      );
      return;
    }
    void body(request).then((payload) => {
      const model = str(payload.model) ?? "";
      if (!key.models.includes(model)) {
        errorBody(
          response,
          403,
          "key_model_access_denied",
          `The requested model '${model}' is not available for this API key, or the model name is invalid. Check the models available to you and try again.`,
          "model",
        );
        return;
      }
      if (key.spendUsd + callCostUsd > key.maxBudgetUsd + 1e-9) {
        errorBody(
          response,
          422,
          "budget_exceeded",
          `Budget has been exceeded! Key=${key.alias} Current cost: ${spendString(key.spendUsd)}, Max budget: ${key.maxBudgetUsd}`,
        );
        return;
      }
      requestCounter += 1;
      const requestId = `req_fake_${requestCounter}`;
      const startedAt = now().toISOString();
      key.spendUsd = Math.round((key.spendUsd + callCostUsd) * 1_000_000) / 1_000_000;
      spend.push({
        requestId,
        keyHash: key.hash,
        teamId: key.teamId,
        userId: key.userId,
        model,
        spendUsd: callCostUsd,
        promptTokens,
        completionTokens,
        startedAt,
        callType:
          route === "/v1/messages"
            ? "anthropic_messages"
            : route === "/v1/responses"
              ? "responses"
              : "chat_completions",
      });
      if (route === "/v1/messages") {
        json(response, 200, {
          id: `msg_${requestId}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: promptTokens, output_tokens: completionTokens },
        });
        return;
      }
      if (route === "/v1/responses") {
        json(response, 200, {
          id: `resp_${requestId}`,
          object: "response",
          model,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
        return;
      }
      json(response, 200, {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (request.method ?? "GET").toUpperCase();

    if (path === "/health/liveliness" || path === "/health/readiness") {
      json(response, 200, { status: "healthy" });
      return;
    }
    if (path === "/__state") {
      json(response, 200, {
        keys: [...keys.values()].map(keyRecord),
        spend: spend.map((row) => ({ ...row })),
        teams: [...teams.entries()],
        users: [...users.entries()],
      });
      return;
    }
    if (path.startsWith("/v1/")) {
      modelCall(request, response, path);
      return;
    }

    const payload = method === "GET" ? {} : await body(request);

    if (method === "POST" && path === "/key/generate") {
      const alias = str(payload.key_alias);
      if (alias === null) {
        errorBody(response, 400, "bad_request", "key_alias is required");
        return;
      }
      const secret = issueSecret();
      keys.set(alias, {
        alias,
        secret,
        hash: sha256(secret),
        models: listOf(payload.models) ?? [],
        maxBudgetUsd: num(payload.max_budget) ?? 0,
        budgetDuration: str(payload.budget_duration) ?? "1d",
        tpmLimit: num(payload.tpm_limit),
        rpmLimit: num(payload.rpm_limit),
        blocked: false,
        teamId: str(payload.team_id),
        userId: str(payload.user_id),
        spendUsd: 0,
      });
      json(response, 200, { key: secret, key_alias: alias, key_name: alias });
      return;
    }
    if (method === "POST" && path === "/key/update") {
      const alias = str(payload.key_alias);
      const key = alias === null ? null : (keys.get(alias) ?? null);
      if (key === null) {
        errorBody(response, 404, "not_found", "key not found");
        return;
      }
      if (listOf(payload.models) !== null) key.models = listOf(payload.models) ?? key.models;
      const budget = num(payload.max_budget);
      if (budget !== null) key.maxBudgetUsd = budget;
      const duration = str(payload.budget_duration);
      if (duration !== null) key.budgetDuration = duration;
      key.tpmLimit = num(payload.tpm_limit);
      key.rpmLimit = num(payload.rpm_limit);
      if (typeof payload.blocked === "boolean") key.blocked = payload.blocked;
      json(response, 200, { key_alias: alias, updated: true });
      return;
    }
    if (method === "POST" && path === "/key/delete") {
      const aliases = listOf(payload.key_aliases) ?? [];
      for (const alias of aliases) keys.delete(alias);
      json(response, 200, { deleted_keys: aliases });
      return;
    }
    if (method === "POST" && (path === "/key/block" || path === "/key/unblock")) {
      const hash = str(payload.key);
      const key = hash === null ? null : findByHash(hash);
      if (key === null) {
        errorBody(response, 404, "not_found", "key not found");
        return;
      }
      key.blocked = path === "/key/block";
      json(response, 200, { key_alias: key.alias, blocked: key.blocked });
      return;
    }
    if (method === "GET" && path === "/key/info") {
      const hash = url.searchParams.get("key");
      const key = hash === null ? null : findByHash(hash);
      if (key === null) {
        errorBody(response, 404, "not_found", "key not found");
        return;
      }
      json(response, 200, { info: keyRecord(key) });
      return;
    }
    if (method === "GET" && path === "/key/list") {
      const alias = url.searchParams.get("key_alias");
      const rows = [...keys.values()].filter((key) => alias === null || key.alias === alias);
      json(response, 200, { keys: rows.map(keyRecord) });
      return;
    }
    if (method === "POST" && path === "/team/new") {
      requestCounter += 1;
      const teamId = `team_fake_${requestCounter}`;
      teams.set(teamId, {
        alias: str(payload.team_alias) ?? teamId,
        maxBudget: num(payload.max_budget) ?? 0,
        models: listOf(payload.models) ?? [],
      });
      json(response, 200, { team_id: teamId });
      return;
    }
    if (method === "POST" && path === "/team/update") {
      json(response, 200, { team_id: str(payload.team_id), updated: true });
      return;
    }
    if (method === "POST" && path === "/team/delete") {
      json(response, 200, { deleted_teams: listOf(payload.team_ids) ?? [] });
      return;
    }
    if (method === "GET" && path === "/team/info") {
      const teamId = url.searchParams.get("team_id") ?? "";
      const team = teams.get(teamId);
      if (team === undefined) {
        errorBody(response, 404, "not_found", "team not found");
        return;
      }
      json(response, 200, {
        team_id: teamId,
        team_info: { team_id: teamId, team_alias: team.alias, max_budget: team.maxBudget },
      });
      return;
    }
    if (method === "GET" && path === "/team/list") {
      json(response, 200, {
        teams: [...teams.entries()].map(([teamId, team]) => ({
          team_id: teamId,
          team_alias: team.alias,
          max_budget: team.maxBudget,
        })),
      });
      return;
    }
    if (method === "POST" && path === "/team/member_add") {
      json(response, 200, { updated: true });
      return;
    }
    if (method === "POST" && path === "/team/member_update") {
      json(response, 200, { updated: true });
      return;
    }
    if (method === "POST" && path === "/team/member_delete") {
      json(response, 200, { deleted: true });
      return;
    }
    if (method === "POST" && path === "/user/new") {
      const userId = str(payload.user_id) ?? `user_fake_${keys.size + 1}`;
      users.set(userId, {
        alias: str(payload.user_alias),
        email: str(payload.user_email),
        teams: listOf(payload.teams) ?? [],
      });
      json(response, 200, { user_id: userId });
      return;
    }
    if (method === "POST" && path === "/user/update") {
      json(response, 200, { updated: true });
      return;
    }
    if (method === "GET" && path === "/user/info") {
      const userId = url.searchParams.get("user_id") ?? "";
      const user = users.get(userId);
      if (user === undefined) {
        errorBody(response, 404, "not_found", "user not found");
        return;
      }
      json(response, 200, {
        user_id: userId,
        user_info: { user_id: userId, user_alias: user.alias, teams: user.teams },
      });
      return;
    }
    if (method === "GET" && path === "/user/list") {
      json(response, 200, {
        users: [...users.entries()].map(([userId, user]) => ({
          user_id: userId,
          user_alias: user.alias,
        })),
      });
      return;
    }
    if (method === "POST" && path === "/user/delete") {
      json(response, 200, { deleted: true });
      return;
    }
    if (method === "GET" && path === "/spend/logs") {
      const keyHash = url.searchParams.get("api_key");
      const rows = spend
        .filter((row) => keyHash === null || row.keyHash === keyHash)
        .map((row) => ({
          request_id: row.requestId,
          api_key: row.keyHash,
          team_id: row.teamId,
          user: row.userId,
          model_group: row.model,
          spend: row.spendUsd,
          prompt_tokens: row.promptTokens,
          completion_tokens: row.completionTokens,
          total_tokens: row.promptTokens + row.completionTokens,
          startTime: row.startedAt,
          endTime: row.startedAt,
          call_type: row.callType,
        }));
      json(response, 200, { data: rows });
      return;
    }

    errorBody(response, 404, "not_found", `no route ${method} ${path}`);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) errorBody(response, 500, "internal_error", "fake gateway fault");
      else response.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? FAKE_GATEWAY_DEFAULT_PORT, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        keys,
        spend,
        server,
        reset() {
          keys.clear();
          spend.length = 0;
          teams.clear();
          users.clear();
          requestCounter = 0;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** `node e2e/flow/fake-gateway.ts` starts one on 127.0.0.1:18091. */
if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const port = Number.parseInt(process.env.FAKE_GATEWAY_PORT ?? "", 10);
  const started = await startFakeGateway({
    ...(Number.isFinite(port) ? { port } : {}),
    ...(process.env.FAKE_CALL_COST_USD === undefined
      ? {}
      : { callCostUsd: Number(process.env.FAKE_CALL_COST_USD) }),
  });
  process.stdout.write(`fake gateway listening on ${started.url}\n`);
  const shutdown = () => {
    void started.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
