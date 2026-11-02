/**
 * Test harness for the MCP server and CLI tests (not a test file itself).
 *
 * `FakeApi` is an in-memory control-service stand-in on localhost: it answers
 * the member and manager routes with fixed
 * fixture data, checks bearer tokens by role, and records every call.
 * `McpHarness` spawns the real `taa mcp` child and drives it with raw
 * JSON-RPC over stdio, so the tests cover the actual wire protocol.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const MEMBER_KEY = "fixture-member-key";
export const MANAGER_TOKEN = "fixture-manager-token";

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function refusal(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message, details: null } });
}

const ME = {
  memberId: "m-lena",
  displayName: "Lena",
  teamName: "Platform",
  allowedModels: ["flash", "mini"],
  limits: { budgetUsd: 20, period: "weekly", tokenCap: null, rpm: null, tpm: null },
  grants: [],
  blocked: false,
  blockedReason: null,
  effectiveBudgetUsd: 20,
  effectiveTokenCap: null,
  status: "soft",
  spendUsd: 16.6,
  computedAt: "2026-10-26T09:00:00Z",
};

const USAGE = [
  {
    id: "u1",
    memberId: "m-lena",
    modelId: "flash",
    at: "2026-10-25T10:00:00Z",
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 12.1,
    requestId: "req-1",
    apiFormat: "anthropic_messages",
  },
  {
    id: "u2",
    memberId: "m-lena",
    modelId: "mini",
    at: "2026-10-25T11:00:00Z",
    inputTokens: 800,
    outputTokens: 100,
    costUsd: 4.5,
    requestId: "req-2",
    apiFormat: "responses",
  },
];

function baseRequest(
  id: string,
  state: string,
  kind: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    memberId: "m-lena",
    teamId: "t-platform",
    kind,
    amountUsd: null,
    modelId: null,
    message: "fixture reason",
    state,
    context: { spendThisPeriodUsd: 16.6, limitUsd: 20, topModels: [], last7DaysUsd: 16.6 },
    createdAt: "2026-10-26T08:00:00Z",
    expiresAt: "2026-10-29T08:00:00Z",
    decidedAt: null,
    ...extra,
  };
}

const REQUESTS = [
  baseRequest("r-pending", "pending", "more_budget", {
    amountUsd: 5,
    message: "migration needs headroom",
  }),
  baseRequest("r-done", "approved", "model_unlock", { modelId: "flagship" }),
];

const OVERVIEW = {
  team: { id: "t-platform", name: "Platform", monthlyBudgetUsd: 100 },
  members: [
    {
      member: { id: "m-lena", displayName: "Lena", teamId: "t-platform", blocked: false },
      policy: { ...ME, memberId: "m-lena" },
      spendUsd: 16.6,
    },
    {
      member: { id: "m-omar", displayName: "Omar", teamId: "t-platform", blocked: true },
      policy: { ...ME, memberId: "m-omar", status: "blocked", blocked: true },
      spendUsd: 21.0,
    },
  ],
  models: [],
  openRequests: [REQUESTS[0]],
  alerts: [],
};

const AUDIT = [
  {
    id: "a1",
    at: "2026-10-26T08:00:00Z",
    actor: { type: "member", id: "m-lena", displayName: "Lena" },
    action: "request.created",
    objectType: "request",
    objectId: "r-pending",
    before: null,
    after: { state: "pending" },
    reason: null,
  },
];

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** In-memory control-service stand-in on 127.0.0.1. */
export class FakeApi {
  readonly calls: RecordedCall[] = [];
  /** `"METHOD path"` entries answered with this failure instead of fixtures. */
  readonly failures = new Map<string, { status: number; code: string; message: string }>();
  private readonly server: Server;
  readonly url: string;

  private constructor(server: Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(): Promise<FakeApi> {
    const fake = new FakeApi(createServer(), "");
    const server = fake.server;
    server.on("request", (request, response) => {
      void fake.handle(request, response).catch(() => {
        try {
          response.writeHead(500).end();
        } catch {
          /* closed */
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake API did not bind");
    (fake as { url: string }).url = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private roleOf(auth: string | null): "member" | "manager" | null {
    if (auth === `Bearer ${MEMBER_KEY}`) return "member";
    if (auth === `Bearer ${MANAGER_TOKEN}`) return "manager";
    return null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const auth = request.headers["authorization"] ?? null;
    const body = method === "GET" || method === "HEAD" ? null : await readBody(request);
    this.calls.push({ method, path, auth, body });
    const failure = this.failures.get(`${method} ${path}`);
    if (failure !== undefined) {
      refusal(response, failure.status, failure.code, failure.message);
      return;
    }
    if (path === "/") {
      sendJson(response, 404, {
        error: { code: "not_found", message: "no such route", details: null },
      });
      return;
    }
    const role = this.roleOf(auth);
    if (role === null) {
      refusal(response, 401, "unauthorized", "missing or unknown credential");
      return;
    }
    if (path.startsWith("/api/team/") && role !== "manager") {
      refusal(response, 403, "forbidden", "A member key cannot call a manager route.");
      return;
    }

    if (method === "GET" && path === "/api/me") return void sendJson(response, 200, ME);
    if (method === "GET" && path === "/api/me/usage") return void sendJson(response, 200, USAGE);
    if (method === "GET" && path === "/api/me/requests")
      return void sendJson(response, 200, REQUESTS);
    if (method === "POST" && path === "/api/me/doctor")
      return void sendJson(response, 200, { received: true });
    if (
      method === "POST" &&
      path === "/api/me/requests" &&
      body !== null &&
      typeof body === "object"
    ) {
      const input = body as Record<string, unknown>;
      if (typeof input["amountUsd"] === "number" && input["amountUsd"] <= 0) {
        return void refusal(response, 422, "over_limit", "amount must be above zero");
      }
      return void sendJson(
        response,
        200,
        baseRequest("r-new", "pending", String(input["kind"] ?? "suggestion"), {
          amountUsd: (input["amountUsd"] as number | undefined) ?? null,
          modelId: (input["modelId"] as string | undefined) ?? null,
          message: String(input["message"] ?? ""),
        }),
      );
    }
    const cancel = path.match(/^\/api\/me\/requests\/([^/]+)\/cancel$/);
    if (method === "POST" && cancel !== null) {
      return void sendJson(
        response,
        200,
        baseRequest(cancel[1] as string, "cancelled", "more_budget", {}),
      );
    }
    if (method === "GET" && path === "/api/team/overview")
      return void sendJson(response, 200, OVERVIEW);
    if (method === "GET" && path === "/api/team/usage") return void sendJson(response, 200, USAGE);
    if (method === "GET" && path === "/api/team/requests")
      return void sendJson(response, 200, REQUESTS);
    const decide = path.match(/^\/api\/team\/requests\/([^/]+)\/decide$/);
    if (method === "POST" && decide !== null && body !== null && typeof body === "object") {
      const input = body as Record<string, unknown>;
      const outcome = String(input["outcome"] ?? "approved");
      const state =
        outcome === "approved" ? "approved" : outcome === "denied" ? "denied" : "partly_approved";
      return void sendJson(response, 200, {
        request: baseRequest(decide[1] as string, state, "more_budget", {}),
        decision: { outcome, note: (input["note"] as string | undefined) ?? null },
        grant: null,
      });
    }
    const member = path.match(/^\/api\/team\/members\/([^/]+)$/);
    if (method === "GET" && member !== null) {
      return void sendJson(response, 200, {
        member: { id: member[1], displayName: "Lena", teamId: "t-platform", blocked: false },
        policy: ME,
        limits: ME.limits,
        grants: [],
        usage: USAGE,
      });
    }
    const limits = path.match(/^\/api\/team\/members\/([^/]+)\/limits$/);
    if (method === "PATCH" && limits !== null) {
      return void sendJson(response, 200, {
        member: { id: limits[1], displayName: "Lena" },
        policy: ME,
      });
    }
    const models = path.match(/^\/api\/team\/members\/([^/]+)\/models$/);
    if (method === "PATCH" && models !== null && body !== null && typeof body === "object") {
      const ids = (body as { modelIds?: unknown }).modelIds;
      if (!Array.isArray(ids))
        return void refusal(response, 400, "invalid", "modelIds must be an array");
      return void sendJson(response, 200, {
        member: { id: models[1], displayName: "Lena" },
        policy: ME,
      });
    }
    const block = path.match(/^\/api\/team\/members\/([^/]+)\/key\/block$/);
    if (method === "POST" && block !== null) {
      if (
        body === null ||
        typeof body !== "object" ||
        typeof (body as Record<string, unknown>)["reason"] !== "string"
      ) {
        return void refusal(response, 400, "invalid", "a reason is required to block a key");
      }
      return void sendJson(response, 200, {
        member: { id: block[1], displayName: "Lena", blocked: true },
        policy: ME,
      });
    }
    const unblock = path.match(/^\/api\/team\/members\/([^/]+)\/key\/unblock$/);
    if (method === "POST" && unblock !== null) {
      return void sendJson(response, 200, {
        member: { id: unblock[1], displayName: "Lena", blocked: false },
        policy: ME,
      });
    }
    if (method === "GET" && path === "/api/team/audit") return void sendJson(response, 200, AUDIT);
    return void refusal(response, 404, "not_found", `no such route: ${method} ${path}`);
  }
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Drives the real `taa mcp` child over stdio with raw JSON-RPC. */
export class McpHarness {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private buffer = "";
  readonly stderr: string[] = [];
  /** Every stdout line the child wrote; all must be JSON. */
  readonly stdoutLines: string[] = [];

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  static async start(
    cliPath: string,
    role: "member" | "manager",
    env: NodeJS.ProcessEnv,
  ): Promise<McpHarness> {
    const child = spawn(process.execPath, [cliPath, "mcp", "--role", role], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const harness = new McpHarness(child);
    const hello = await harness.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "taa-harness", version: "0.1.0" },
    });
    if (hello.error !== undefined) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(hello.error)}`);
    }
    harness.notify("notifications/initialized", {});
    return harness;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") {
        this.stdoutLines.push(line);
        this.dispatch(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (message.id === null || message.id === undefined) return;
    const resolve = this.pending.get(message.id as number);
    if (resolve !== undefined) {
      this.pending.delete(message.id as number);
      resolve(message);
    }
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin?.write(line, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const response = await this.send("tools/list", {});
    if (response.error !== undefined)
      throw new Error(`tools/list failed: ${response.error.message}`);
    return (response.result as { tools: Array<{ name: string; description?: string }> }).tools;
  }

  callTool(name: string, args: unknown): Promise<JsonRpcResponse> {
    return this.send("tools/call", { name, arguments: args });
  }

  async stop(): Promise<number | null> {
    this.child.stdin?.end();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve(null);
      }, 5_000);
      this.child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}
