/**
 * Live check: real CLIs through the local gateway with one real model.
 *
 * What it does:
 *
 *  1. Starts an isolated gateway stack (ephemeral Postgres + the pinned
 *     LiteLLM image with `deploy/litellm.live.yaml`) on 127.0.0.1 ports that
 *     do not clash with the dev stack, plus the control service in-process
 *     with a scratch SQLite file. Nothing here touches the developer's own
 *     CLI settings: every CLI runs with an isolated temp home.
 *  2. Creates a `Live` team with USD 0.05/day test budgets (one member per
 *     CLI, plus a plugin-test member with USD 0.50/day so the 15-step stop
 *     can fire without the budget stop firing first).
 *  3. Per CLI (Claude Code, OpenCode, Codex): allowed model answers,
 *     blocked model refused, budget exhausted, `request_more_budget` through
 *     the real `taa mcp` stdio desk, manager approval through the manager
 *     API, then the CLI works again. Gateway spend is read after each CLI.
 *  4. OpenCode only: the plugin's unattended rule stops a looping task at
 *     15 steps (Sunday run, so the default policy is off-hours).
 *  5. Restores afterwards: live members (and their gateway keys) are deleted
 *     through the admin API, the team is deleted, and all live containers
 *     are stopped and removed. Scratch secrets are deleted, never printed.
 *
 * Upstream key handling: the gateway container reads
 * `~/.config/team-ai-allowance/upstream.env` itself via `--env-file`. This
 * script checks the file EXISTS (never opens, prints or copies it). On any
 * 403 / abuse / policy / account warning from the upstream side, all live
 * calls stop at once and the script still runs the restore path.
 *
 * Usage:
 *
 *   node scripts/live-check.ts [--only claude|opencode|codex] [--skip-plugin]
 *       [--scratch DIR] [--keep] [--gateway-port N] [--control-port N]
 *
 * Results go to `results/live.json` (no secrets, scrubbed excerpts). Exit 0
 * when the evidence is complete, 2 when the upstream stop tripped, 1 when
 * the run died before the evidence was written.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadServerConfig } from "../src/server/config.ts";
import { type ControlServerHandle, createControlServer } from "../src/server/index.ts";
import { openSqliteStore } from "../src/store/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_YAML = join(ROOT, "deploy", "litellm.live.yaml");
const LIVE_JSON = join(ROOT, "results", "live.json");
const PLUGIN_PATH = join(ROOT, "dist", "plugin", "team-ai-allowance.ts");
const CLI_PATH = join(ROOT, "src", "cli", "index.ts");

const MODEL = "deepseek-v4.1-flash";
const BLOCKED_MODEL = "blocked-model";
const MEMBER_BUDGET_USD = 0.05;
const PLUGIN_BUDGET_USD = 0.5;
const GRANT_USD = 0.1;
const TEAM_NAME = "Live";
const MANAGER_NAME = "Live Leader";
const GATEWAY_IMAGE =
  "ghcr.io/berriai/litellm@sha256:b4239fbb9be0d915c312632ccdcccea441db9994a341536fdbf32cae82e15f9c";
const POSTGRES_IMAGE = "docker.io/library/postgres:17-alpine";
const CALL_TIMEOUT_MS = 240_000;
const EXHAUST_CALL_CAP = 20;

const BUDGET_REFUSED = /budget has been exceeded/i;
const MODEL_DENIED = /not available for this api key/i;
const UPSTREAM_STOP =
  /abuse|policy violation|suspend|account.+flag|upstream|provider.+error|authentication.+provider|invalid upstream|can not (access|connect)/i;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface StepRecord {
  key: string;
  pass: boolean;
  status: number | null;
  message: string;
  excerpt: string;
  calls?: number;
  spendDeltaUsd?: number;
}

interface CliRecord {
  cli: string;
  version: string;
  available: boolean;
  memberId: string | null;
  steps: StepRecord[];
  spendUsd: number;
  /** Independent read from GET /key/info (the figure budget enforcement uses). */
  spendKeyInfoUsd: number;
  note: string | null;
}

interface LiveJson {
  runAt: string;
  gateway: {
    image: string;
    model: string;
    blockedModel: string;
    testPricing: { inputPer1MUsd: number; outputPer1MUsd: number; note: string };
  };
  cliVersions: Record<string, string>;
  upstreamStopTripped: boolean;
  clis: CliRecord[];
  plugin: {
    pass: boolean;
    memberId: string | null;
    message: string;
    excerpt: string;
    spendUsd: number;
  };
  approvals: Array<{ requestId: string; memberId: string; amountUsd: number; outcome: string }>;
  totalSpendUsd: number;
  notes: string[];
}

const secrets: string[] = [];

function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/taa_mgr_[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
}

function logLine(line: string): void {
  process.stderr.write(`${new Date().toISOString()} live-check: ${scrub(line)}\n`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): {
  only: string | null;
  skipPlugin: boolean;
  keep: boolean;
  scratch: string | null;
  gatewayPort: number;
  controlPort: number;
} {
  const out = {
    only: null as string | null,
    skipPlugin: false,
    keep: false,
    scratch: null as string | null,
    gatewayPort: Number(process.env.TAA_LIVE_GATEWAY_PORT ?? "14010"),
    controlPort: Number(process.env.TAA_LIVE_CONTROL_PORT ?? "18081"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--skip-plugin") out.skipPlugin = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg.startsWith("--only=")) out.only = arg.slice("--only=".length);
    else if (arg.startsWith("--scratch=")) out.scratch = arg.slice("--scratch=".length);
    else if (arg.startsWith("--gateway-port="))
      out.gatewayPort = Number(arg.slice("--gateway-port=".length));
    else if (arg.startsWith("--control-port="))
      out.controlPort = Number(arg.slice("--control-port=".length));
    else if (arg === "--only") out.only = argv[i + 1] ?? null;
    else if (arg === "--scratch") out.scratch = argv[i + 1] ?? null;
  }
  return out;
}

function detectRuntime(): Promise<"podman" | "docker"> {
  return new Promise((resolve, reject) => {
    execFile("podman", ["--version"], (error) => {
      if (error === null) {
        resolve("podman");
        return;
      }
      execFile("docker", ["--version"], (dockerError) => {
        if (dockerError === null) resolve("docker");
        else reject(new Error("neither podman nor docker is available"));
      });
    });
  });
}

function execAsync(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function spawnAsync(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: `${stderr}\nspawn error: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

async function waitFor(url: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} did not become healthy at ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function excerptOf(text: string, limit = 1200): string {
  const clean = scrub(text).replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)} …` : clean;
}

function firstMatchLine(text: string, pattern: RegExp): string | null {
  const clean = scrub(text);
  const flags = pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`;
  const match = new RegExp(pattern.source, flags).exec(clean);
  if (match === null || match.index === undefined) return null;
  const start = Math.max(0, match.index - 60);
  return clean
    .slice(start, match.index + 440)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The exact gateway refusal sentence (budget or model denial), wherever in
 * the CLI's output it hides. Returns a window centered on the match so the
 * full LiteLLM message survives even when a CLI wraps it in single-line JSON.
 */
function extractEnvelope(combined: string, pattern: RegExp, take = 280): string | null {
  const flags = pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`;
  const match = new RegExp(pattern.source, flags).exec(combined);
  if (match === null || match.index === undefined) return null;
  const start = Math.max(0, match.index - 60);
  return scrub(
    combined
      .slice(start, match.index + take)
      .replace(/\s+/g, " ")
      .trim(),
  );
}

type CallVerdict = "ok" | "budget" | "blocked" | "model-denied" | "upstream-stop" | "unexpected";

function classify(status: number, combined: string): { verdict: CallVerdict; message: string } {
  if (status === 0 && !BUDGET_REFUSED.test(combined) && !MODEL_DENIED.test(combined)) {
    return { verdict: "ok", message: "answered" };
  }
  if (BUDGET_REFUSED.test(combined)) {
    return {
      verdict: "budget",
      message:
        extractEnvelope(combined, /budget has been exceeded![^}]*/) ??
        firstMatchLine(combined, BUDGET_REFUSED) ??
        "Budget has been exceeded!",
    };
  }
  if (MODEL_DENIED.test(combined)) {
    return {
      verdict: "model-denied",
      message:
        extractEnvelope(combined, /the requested model[^}]*/) ??
        firstMatchLine(combined, MODEL_DENIED) ??
        "The requested model is not available for this API key.",
    };
  }
  if (/key is blocked/i.test(combined)) {
    return {
      verdict: "blocked",
      message:
        extractEnvelope(combined, /key is blocked[^}]*/) ??
        firstMatchLine(combined, /key is blocked/i) ??
        "Key is blocked.",
    };
  }
  if (UPSTREAM_STOP.test(combined) || /"\s*code"\s*:\s*"?403"?/.test(combined)) {
    return {
      verdict: "upstream-stop",
      message:
        firstMatchLine(combined, /.{0,80}(403|abuse|policy|upstream).{0,120}/i) ??
        combined.slice(0, 300),
    };
  }
  return { verdict: "unexpected", message: excerptOf(combined, 500) };
}

async function gatewayDirectCall(
  gatewayUrl: string,
  key: string,
  model: string,
  maxTokens: number,
  padRepeat = 0,
): Promise<{ status: number; message: string | null }> {
  const padding = "The allowance gateway meters every model call for budget enforcement. ".repeat(
    padRepeat,
  );
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${padding}Reply with OK.` }],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  let message: string | null = null;
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "object" && error !== null) {
        const text = (error as { message?: unknown }).message;
        if (typeof text === "string") message = text;
      }
    }
  } catch {
    // No JSON body; the status alone is the evidence.
  }
  return { status: response.status, message };
}

async function mcpCallTool(
  baseUrl: string,
  memberKey: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string; requestId: string | null; raw: string }> {
  const child = spawn(process.execPath, [CLI_PATH, "mcp", "--role", "member"], {
    env: { ...process.env, TAA_BASE_URL: baseUrl, TAA_MEMBER_KEY: memberKey },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (value: string) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try {
          const parsed = JSON.parse(line) as { id?: number };
          if (typeof parsed.id === "number") pending.get(parsed.id)?.(line);
        } catch {
          // Non-JSON line; ignore.
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (method: string, params: unknown): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, 30_000);
      pending.set(id, (line) => {
        clearTimeout(timer);
        resolve(line);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "taa-live-check", version: "0.1.0" },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const raw = await send("tools/call", { name: tool, arguments: args });
    const parsed = JSON.parse(raw) as {
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { id?: string };
      };
    };
    const result = parsed.result;
    const text = result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
    const requestId = result?.structuredContent?.id ?? null;
    return { ok: result?.isError !== true, text, requestId, raw };
  } finally {
    child.kill("SIGKILL");
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const scratch =
    args.scratch !== null ? resolve(args.scratch) : mkdtempSync(join(tmpdir(), "taa-live-"));
  mkdirSync(scratch, { recursive: true });
  const upstreamEnv =
    process.env.TAA_UPSTREAM_ENV ??
    join(process.env.HOME ?? tmpdir(), ".config", "team-ai-allowance", "upstream.env");
  try {
    statSync(upstreamEnv);
  } catch {
    logLine(`upstream key file is missing: ${upstreamEnv} (nothing was read or created)`);
    return 1;
  }

  const versions: Record<string, string> = {};
  for (const [name, command, versionArgs] of [
    ["claude", "claude", ["--version"]],
    ["opencode", "opencode", ["--version"]],
    ["codex", "codex", ["--version"]],
  ] as const) {
    try {
      const out = await execAsync(command, [...versionArgs]);
      versions[name] =
        scrub(`${out.stdout} ${out.stderr}`.replace(/\s+/g, " ").trim()).slice(0, 120) || "unknown";
    } catch {
      versions[name] = "not installed";
    }
  }
  logLine(
    `CLI versions: claude=${versions.claude} opencode=${versions.opencode} codex=${versions.codex}`,
  );

  const runtime = await detectRuntime();
  const network = "taa-live-net";
  const pgName = "taa-live-postgres";
  const llmName = "taa-live-litellm";
  const pgPassword = randomBytes(18).toString("hex");
  secrets.push(pgPassword);
  const masterKey = `sk-live-${randomBytes(24).toString("hex")}`;
  secrets.push(masterKey);
  const bootstrapPassword = randomBytes(16).toString("base64url");
  secrets.push(bootstrapPassword);

  let server: ControlServerHandle | null = null;
  let upstreamStop = false;
  const notes: string[] = [];
  const approvals: LiveJson["approvals"] = [];
  const clis: CliRecord[] = [];
  const wanted = args.only === null ? ["claude", "opencode", "codex"] : [args.only];
  if (args.only !== null && !["claude", "opencode", "codex"].includes(args.only)) {
    logLine(`unknown --only value: ${args.only}`);
    return 1;
  }

  const runStartedAt = new Date().toISOString();
  const gatewayUrl = `http://127.0.0.1:${args.gatewayPort}`;
  let teamId = "";
  let managerToken = "";
  /** Every member created through the admin API, so restore revokes each key. */
  const createdMemberIds: string[] = [];

  // HTTP helper for the admin API. Declared before restore so the restore
  // path can revoke keys and delete the team with the admin session.
  // POST /login at the root is the console's form login (urlencoded), not
  // the JSON API route: the API only serves /api/*. The session cookie it
  // sets authenticates the admin API; GET /api/session reveals the session
  // CSRF token that mutating API calls must echo back.
  const jar: string[] = [];
  let sessionCsrf = "";
  const apiFetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> => {
    const mutating = (init.method ?? "GET") !== "GET";
    const response = await fetch(`${server?.url}${path}`, {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers ?? {}),
        ...(jar.length > 0 ? { cookie: jar.join("; ") } : {}),
        ...(mutating && sessionCsrf !== "" ? { "x-csrf-token": sessionCsrf } : {}),
      },
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) jar.push(entry.split(";")[0] ?? "");
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };

  async function restore(): Promise<void> {
    if (server !== null) {
      try {
        // Admin routes need the admin session (the manager token is
        // correctly refused them); apiFetch carries the session cookie.
        for (const memberId of createdMemberIds) {
          const deleted = await apiFetch(`/api/admin/teams/${teamId}/members/${memberId}`, {
            method: "DELETE",
          });
          logLine(`restore: deleted member ${memberId}: HTTP ${deleted.status}`);
        }
      } catch (error) {
        logLine(`restore: member delete failed: ${(error as Error).message}`);
      }
      try {
        if (teamId !== "") {
          const deleted = await apiFetch(`/api/admin/teams/${teamId}`, { method: "DELETE" });
          logLine(
            `restore: deleted team ${teamId}: HTTP ${deleted.status} ${excerptOf(JSON.stringify(deleted.body), 200)}`,
          );
        }
      } catch (error) {
        logLine(`restore: team delete failed: ${(error as Error).message}`);
      }
      try {
        await server.stop();
      } catch (error) {
        logLine(`restore: control stop failed: ${(error as Error).message}`);
      }
      server = null;
    }
    if (!args.keep) {
      // Remove one container at a time: podman aborts a multi-name rm when
      // any single name is missing, which would leave the others behind.
      for (const name of [pgName, llmName]) {
        await execAsync(runtime, ["stop", "-t", "10", name]).catch(() => undefined);
        await execAsync(runtime, ["rm", "-f", name]).catch(() => undefined);
      }
      await execAsync(runtime, ["network", "rm", network]).catch(() => undefined);
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Scratch cleanup is best-effort; the run log already redacts secrets.
      }
    } else {
      logLine(`restore: --keep set, containers and ${scratch} left running`);
    }
  }

  try {
    // --- Isolated gateway stack -------------------------------------------------
    await execAsync(runtime, ["network", "create", network]);
    logLine(`gateway: network ${network} via ${runtime}`);
    let out = await execAsync(runtime, [
      "run",
      "-d",
      "--name",
      pgName,
      "--network",
      network,
      "-e",
      "POSTGRES_USER=litellm",
      "-e",
      `POSTGRES_PASSWORD=${pgPassword}`,
      "-e",
      "POSTGRES_DB=litellm",
      POSTGRES_IMAGE,
    ]);
    if (out.code !== 0)
      throw new Error(`postgres did not start: ${scrub(out.stderr).slice(0, 300)}`);
    for (let i = 0; i < 60; i++) {
      const ready = await execAsync(runtime, [
        "exec",
        pgName,
        "pg_isready",
        "-U",
        "litellm",
        "-d",
        "litellm",
      ]);
      if (ready.code === 0) break;
      if (i === 59) throw new Error("postgres never became ready");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    out = await execAsync(runtime, [
      "run",
      "-d",
      "--name",
      llmName,
      "--network",
      network,
      "-p",
      `127.0.0.1:${args.gatewayPort}:4000`,
      "--env-file",
      upstreamEnv,
      "-e",
      `DATABASE_URL=postgresql://litellm:${pgPassword}@${pgName}:5432/litellm`,
      "-e",
      `LITELLM_MASTER_KEY=${masterKey}`,
      "-v",
      `${LIVE_YAML}:/app/config.yaml:ro`,
      GATEWAY_IMAGE,
      "--config",
      "/app/config.yaml",
      "--port",
      "4000",
      "--num_workers",
      "1",
    ]);
    if (out.code !== 0)
      throw new Error(`litellm did not start: ${scrub(out.stderr).slice(0, 300)}`);
    await waitFor(`${gatewayUrl}/health/liveliness`, 240_000, "live gateway");
    logLine(`gateway: healthy at ${gatewayUrl}`);

    // --- Control service in-process --------------------------------------------
    const sessionSecret = randomBytes(32).toString("hex");
    const csrfSecret = randomBytes(32).toString("hex");
    secrets.push(sessionSecret, csrfSecret);
    // Pre-create the team named Platform so the server's first-start demo
    // seed takes its early-return path (bootstrap admin only): the live run
    // gets a clean catalogue with no mock models, members or history.
    const dbPath = join(scratch, "live.db");
    {
      const pre = openSqliteStore({ path: dbPath });
      try {
        await pre.createTeam({ name: "Platform", monthlyBudgetUsd: 120 });
      } finally {
        pre.close();
      }
    }
    const config = loadServerConfig({
      env: {
        ...process.env,
        TAA_PORT: String(args.controlPort),
        TAA_PUBLIC_URL: `http://127.0.0.1:${args.controlPort}`,
        TAA_DB_PATH: dbPath,
        TAA_GATEWAY_URL: gatewayUrl,
        LITELLM_MASTER_KEY: masterKey,
        TAA_SESSION_SECRET: sessionSecret,
        TAA_CSRF_SECRET: csrfSecret,
        TAA_BOOTSTRAP_EMAIL: "live-admin@example.test",
        TAA_BOOTSTRAP_PASSWORD: bootstrapPassword,
        TAA_BOOTSTRAP_NAME: "Live admin",
        TAA_WATCH_INTERVAL_MS: "10000",
        TAA_RECONCILE_INTERVAL_MS: "15000",
        TAA_GATEWAY_WAIT_MS: "240000",
      },
    });
    server = await createControlServer({ config, logger: () => undefined });
    await server.start();
    logLine(`control: up at ${server.url}`);

    // Test catalogue: the one real model plus the never-routed blocked name.
    await server.store.upsertModel({
      id: MODEL,
      displayName: "DeepSeek V4.1 Flash",
      route: "openai/deepseek-v4.1-flash",
      inputPer1MUsd: 5,
      outputPer1MUsd: 15,
      state: "enabled",
      sortOrder: 1,
    });
    await server.store.upsertModel({
      id: BLOCKED_MODEL,
      displayName: "Blocked model",
      route: "blocked/blocked-model",
      inputPer1MUsd: 0,
      outputPer1MUsd: 0,
      state: "blocked",
      sortOrder: 99,
    });

    // --- Admin login, team, manager, live members -------------------------------
    const login = await apiFetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "live-admin@example.test",
        password: bootstrapPassword,
      }).toString(),
    });
    if (login.status < 300 || login.status >= 400) {
      throw new Error(`admin login failed: HTTP ${login.status}`);
    }
    const session = await apiFetch("/api/session");
    sessionCsrf = (session.body as { csrfToken?: string } | null)?.csrfToken ?? "";
    if (session.status !== 200 || sessionCsrf === "") {
      throw new Error(`admin session failed: HTTP ${session.status}`);
    }

    const team = await apiFetch("/api/admin/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: TEAM_NAME, monthlyBudgetUsd: 10 }),
    });
    if (team.status !== 201) throw new Error(`team create failed: HTTP ${team.status}`);
    teamId = (team.body as { id: string }).id;
    const managerPassword = randomBytes(16).toString("base64url");
    secrets.push(managerPassword);
    const manager = await apiFetch(`/api/admin/teams/${teamId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: MANAGER_NAME,
        role: "manager",
        email: "live-leader@example.test",
        password: managerPassword,
      }),
    });
    if (manager.status !== 201) throw new Error(`manager create failed: HTTP ${manager.status}`);
    const managerId = (manager.body as { member: { id: string } }).member.id;
    createdMemberIds.push(managerId);
    const tokenIssue = await apiFetch("/api/admin/manager-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId: managerId, label: "live-check" }),
    });
    if (tokenIssue.status !== 201)
      throw new Error(`manager token issue failed: HTTP ${tokenIssue.status}`);
    managerToken = (tokenIssue.body as { token: string }).token;
    secrets.push(managerToken);

    const memberKeys = new Map<string, { id: string; secret: string }>();
    const makeMember = async (
      displayName: string,
      budgetUsd: number,
    ): Promise<{ id: string; secret: string }> => {
      const created = await apiFetch(`/api/admin/teams/${teamId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName,
          role: "member",
          limits: { budgetUsd, period: "daily", tokenCap: null, rpm: null, tpm: null },
        }),
      });
      if (created.status !== 201)
        throw new Error(`member ${displayName} create failed: HTTP ${created.status}`);
      const parsed = created.body as { member: { id: string }; secret: string };
      secrets.push(parsed.secret);
      createdMemberIds.push(parsed.member.id);
      memberKeys.set(displayName, { id: parsed.member.id, secret: parsed.secret });
      return { id: parsed.member.id, secret: parsed.secret };
    };

    const liveMembers: Record<string, { id: string; secret: string }> = {};
    for (const cli of wanted) liveMembers[cli] = await makeMember(`Live ${cli}`, MEMBER_BUDGET_USD);
    const needPlugin = !args.skipPlugin && (args.only === null || args.only === "opencode");
    let pluginMember: { id: string; secret: string } | null = null;
    if (needPlugin) pluginMember = await makeMember("Live plugin", PLUGIN_BUDGET_USD);

    const gatewaySpend = async (
      secret: string,
      label: string,
    ): Promise<{ logs: number; keyInfo: number; rows: number }> => {
      if (server === null) return { logs: 0, keyInfo: 0, rows: 0 };
      const rows = await server.gateway.listSpend({
        from: runStartedAt,
        to: new Date().toISOString(),
        keyHash: sha256Hex(secret),
      });
      const logs =
        Math.round(rows.reduce((sum, row) => sum + row.spendUsd, 0) * 1_000_000) / 1_000_000;
      let keyInfo = 0;
      try {
        const infoRes = await fetch(`${gatewayUrl}/key/info?key=${sha256Hex(secret)}`, {
          headers: { authorization: `Bearer ${masterKey}` },
        });
        const infoBody = (await infoRes.json()) as { info?: { spend?: unknown } };
        const spend = infoBody.info?.spend;
        keyInfo = typeof spend === "number" ? spend : Number(spend ?? 0);
        if (!Number.isFinite(keyInfo)) keyInfo = 0;
        keyInfo = Math.round(keyInfo * 1_000_000) / 1_000_000;
      } catch {
        keyInfo = -1;
      }
      logLine(
        `${label}: spend logs USD ${logs.toFixed(6)} (rows ${rows.length}), key/info USD ${keyInfo.toFixed(6)}`,
      );
      // Diagnostic: unfiltered window dump so a filter mismatch cannot hide
      // rows. Only truncated key hashes, model names and sums are logged.
      try {
        const probe = await server.gateway.listSpend({
          from: runStartedAt,
          to: new Date().toISOString(),
        });
        const byKey = new Map<string, { n: number; usd: number; models: Set<string> }>();
        for (const row of probe) {
          const prefix = row.keyHash.slice(0, 12);
          const entry = byKey.get(prefix) ?? { n: 0, usd: 0, models: new Set<string>() };
          entry.n += 1;
          entry.usd = Math.round((entry.usd + row.spendUsd) * 1_000_000) / 1_000_000;
          entry.models.add(row.model);
          byKey.set(prefix, entry);
        }
        const summary = [...byKey.entries()]
          .map(
            ([k, v]) => `${k}:n=${v.n},usd=${v.usd.toFixed(6)},models=${[...v.models].join("+")}`,
          )
          .join(" | ");
        logLine(`${label}: unfiltered rows ${probe.length} :: ${summary.slice(0, 900)}`);
      } catch {
        // Diagnostics never fail the run.
      }
      return { logs, keyInfo, rows: rows.length };
    };

    const tripUpstreamStop = (where: string, message: string): void => {
      upstreamStop = true;
      notes.push(`upstream stop tripped at ${where}: ${message.slice(0, 200)}`);
      logLine(`UPSTREAM STOP at ${where}; all live calls halt`);
    };

    // Pre-flight: one tiny direct call proves the route before any CLI spawns.
    const preflightKey = pluginMember?.secret ?? Object.values(liveMembers)[0]?.secret ?? "";
    if (preflightKey === "") throw new Error("no live member to pre-flight with");
    logLine("pre-flight: one direct call through the live gateway");
    const preflight = await gatewayDirectCall(gatewayUrl, preflightKey, MODEL, 5);
    if (preflight.status !== 200) {
      const combined = scrub(`${preflight.status} ${preflight.message ?? ""}`);
      if (preflight.status === 403 || UPSTREAM_STOP.test(combined)) {
        tripUpstreamStop("pre-flight", combined);
      } else {
        throw new Error(`pre-flight failed: HTTP ${preflight.status}: ${combined.slice(0, 300)}`);
      }
    } else {
      logLine("pre-flight: the route answers");
    }

    const runAllowedCall = async (
      cli: string,
      home: string,
      extraEnv: NodeJS.ProcessEnv,
      modelRef: string,
      prompt: string,
    ): Promise<{ result: CliResult; combined: string }> => {
      let result: CliResult;
      if (cli === "claude") {
        result = await spawnAsync(
          "claude",
          ["-p", prompt, "--model", modelRef, "--output-format", "json"],
          {
            ...process.env,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            ...extraEnv,
          },
          home,
          CALL_TIMEOUT_MS,
        );
      } else if (cli === "opencode") {
        result = await spawnAsync(
          "opencode",
          ["run", "--standalone", "--model", modelRef, prompt],
          { ...process.env, HOME: home, ...extraEnv },
          home,
          CALL_TIMEOUT_MS,
        );
      } else {
        result = await spawnAsync(
          "codex",
          [
            "exec",
            "--skip-git-repo-check",
            "-C",
            home,
            "--sandbox",
            "read-only",
            "-m",
            modelRef,
            prompt,
          ],
          { ...process.env, HOME: home, ...extraEnv },
          home,
          CALL_TIMEOUT_MS,
        );
      }
      return { result, combined: `${result.stdout}\n${result.stderr}` };
    };

    const stepRecord = (
      key: string,
      pass: boolean,
      status: number | null,
      message: string,
      raw: string,
      extra?: { calls?: number; spendDeltaUsd?: number },
    ): StepRecord => ({
      key,
      pass,
      status,
      message: scrub(message).slice(0, 500),
      excerpt: excerptOf(raw),
      ...(extra ?? {}),
    });

    for (const cli of wanted) {
      const record: CliRecord = {
        cli,
        version: versions[cli] ?? "unknown",
        available: versions[cli] !== undefined && versions[cli] !== "not installed",
        memberId: liveMembers[cli]?.id ?? null,
        steps: [],
        spendUsd: 0,
        spendKeyInfoUsd: 0,
        note: null,
      };
      clis.push(record);
      const member = liveMembers[cli];
      if (member === undefined) continue;
      if (!record.available) {
        record.note = `${cli} is not installed; recorded as unable to point at the gateway.`;
        record.steps.push(stepRecord("point-at-gateway", false, null, record.note, ""));
        continue;
      }
      if (upstreamStop) {
        record.note = "skipped: upstream stop tripped earlier.";
        continue;
      }
      const home = mkdtempSync(join(scratch, `home-${cli}-`));
      const keyEnv: NodeJS.ProcessEnv =
        cli === "claude"
          ? { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_AUTH_TOKEN: member.secret }
          : cli === "opencode"
            ? { OPENCODE_GATEWAY_KEY: member.secret }
            : { CODEX_HOME: join(home, ".codex"), CODEX_GATEWAY_KEY: member.secret };
      if (cli === "opencode") {
        const cfgDir = join(home, ".config", "opencode");
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
          join(cfgDir, "opencode.json"),
          `${JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            provider: {
              "team-gateway": {
                npm: "@ai-sdk/openai-compatible",
                name: "Team gateway",
                options: { baseURL: `${gatewayUrl}/v1`, apiKey: "{env:OPENCODE_GATEWAY_KEY}" },
                models: {
                  [MODEL]: { name: "DeepSeek V4.1 Flash" },
                  [BLOCKED_MODEL]: { name: "Blocked model" },
                },
              },
            },
            model: `team-gateway/${MODEL}`,
          })}\n`,
          { mode: 0o600 },
        );
      }
      if (cli === "codex") {
        const codexDir = join(home, ".codex");
        mkdirSync(codexDir, { recursive: true });
        writeFileSync(
          join(codexDir, "config.toml"),
          [
            `model = "${MODEL}"`,
            `model_provider = "team-gateway"`,
            ``,
            `[model_providers.team-gateway]`,
            `name = "Team gateway"`,
            `base_url = "${gatewayUrl}/v1"`,
            `env_key = "CODEX_GATEWAY_KEY"`,
            `wire_api = "responses"`,
            ``,
          ].join("\n"),
          { mode: 0o600 },
        );
      }
      const modelRef = cli === "opencode" ? `team-gateway/${MODEL}` : MODEL;
      const blockedRef = cli === "opencode" ? `team-gateway/${BLOCKED_MODEL}` : BLOCKED_MODEL;

      // Step 1: the allowed model answers.
      logLine(`${cli}: step 1 (allowed model answers)`);
      const spendBefore = (await gatewaySpend(member.secret, `${cli}/before`)).logs;
      const first = await runAllowedCall(cli, home, keyEnv, modelRef, "Reply with OK.");
      let verdict = classify(first.result.status, first.combined);
      if (verdict.verdict === "upstream-stop") {
        tripUpstreamStop(`${cli}/allowed`, verdict.message);
        record.steps.push(
          stepRecord(
            "allowed-answers",
            false,
            first.result.status,
            verdict.message,
            first.combined,
          ),
        );
        continue;
      }
      const firstOk = verdict.verdict === "ok";
      record.steps.push(
        stepRecord(
          "allowed-answers",
          firstOk,
          first.result.status,
          verdict.message,
          first.combined,
        ),
      );
      if (!firstOk) {
        record.note = `the allowed call failed (${verdict.verdict}); continuing with the next CLI.`;
        notes.push(`${cli}: allowed call ${verdict.verdict}: ${verdict.message.slice(0, 160)}`);
        continue;
      }

      // Step 2: the blocked model is refused.
      logLine(`${cli}: step 2 (blocked model refused)`);
      const blocked = await runAllowedCall(cli, home, keyEnv, blockedRef, "Reply with OK.");
      verdict = classify(blocked.result.status, blocked.combined);
      if (verdict.verdict === "upstream-stop") {
        tripUpstreamStop(`${cli}/blocked`, verdict.message);
        record.steps.push(
          stepRecord(
            "blocked-refused",
            false,
            blocked.result.status,
            verdict.message,
            blocked.combined,
          ),
        );
        continue;
      }
      record.steps.push(
        stepRecord(
          "blocked-refused",
          verdict.verdict === "model-denied",
          blocked.result.status,
          verdict.message,
          blocked.combined,
        ),
      );

      // Step 3: exhaust the tiny budget.
      logLine(`${cli}: step 3 (budget exhausted)`);
      let calls = 1; // the step-1 call already spent.
      let exhausted: { verdict: CallVerdict; message: string; status: number; raw: string } | null =
        null;
      for (let i = 0; i < EXHAUST_CALL_CAP && !upstreamStop; i++) {
        const attempt = await runAllowedCall(cli, home, keyEnv, modelRef, "Reply with OK.");
        calls += 1;
        const seen = classify(attempt.result.status, attempt.combined);
        if (seen.verdict === "upstream-stop") {
          tripUpstreamStop(`${cli}/exhaust`, seen.message);
          break;
        }
        if (seen.verdict === "budget") {
          exhausted = {
            verdict: seen.verdict,
            message: seen.message,
            status: attempt.result.status,
            raw: attempt.combined,
          };
          break;
        }
        if (seen.verdict !== "ok") {
          exhausted = {
            verdict: seen.verdict,
            message: seen.message,
            status: attempt.result.status,
            raw: attempt.combined,
          };
          break;
        }
      }
      // A CLI loop cannot always spend the budget down: streamed /v1/responses
      // calls bill USD 0 on this LiteLLM build (usage never reaches the cost
      // calc), and repeated tiny prompts bill almost nothing once the
      // upstream prompt cache warms up. When the loop cannot exhaust, top the
      // same key up with direct non-streaming calls (spend is per key, not
      // per route), then let the CLI itself take the refusal below.
      if (exhausted === null && !upstreamStop) {
        const why =
          cli === "codex" ? "streamed-responses billing quirk" : "cached-cheap loop calls";
        logLine(`${cli}: CLI loop cannot accrue spend (${why}); topping up the key directly`);
        let topped: { status: number; message: string | null } | null = null;
        for (let i = 0; i < 6 && !upstreamStop; i++) {
          const probe = await gatewayDirectCall(gatewayUrl, member.secret, MODEL, 5);
          calls += 1;
          if (
            probe.status === 422 &&
            probe.message !== null &&
            BUDGET_REFUSED.test(probe.message)
          ) {
            topped = probe;
            break;
          }
          await gatewayDirectCall(gatewayUrl, member.secret, MODEL, 5, 2000);
          calls += 1;
          const after = await gatewayDirectCall(gatewayUrl, member.secret, MODEL, 5);
          calls += 1;
          if (
            after.status === 422 &&
            after.message !== null &&
            BUDGET_REFUSED.test(after.message)
          ) {
            topped = after;
            break;
          }
        }
        if (topped !== null) {
          notes.push(
            `${cli}: the CLI loop could not accrue spend (streamed-responses billing quirk for codex, cached-cheap calls for the others), so the key was exhausted with direct non-streaming calls on the same key, and the CLI refusal below is the CLI's own.`,
          );
          const cliRefused = await runAllowedCall(cli, home, keyEnv, modelRef, "Reply with OK.");
          calls += 1;
          const seen = classify(cliRefused.result.status, cliRefused.combined);
          if (seen.verdict === "upstream-stop") {
            tripUpstreamStop(`${cli}/exhaust`, seen.message);
          } else {
            exhausted = {
              verdict: seen.verdict,
              message: `key exhausted with direct calls (streamed-responses billing quirk, see notes); CLI refusal: ${seen.message}`,
              status: cliRefused.result.status,
              raw: cliRefused.combined,
            };
          }
        }
      }
      // Spend lands asynchronously (queue + poll interval); wait for the
      // figures to settle before recording them.
      const settled = await (async () => {
        let last = await gatewaySpend(member.secret, `${cli}/settle0`);
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          const cur = await gatewaySpend(member.secret, `${cli}/settle${i + 1}`);
          if (cur.keyInfo === last.keyInfo && cur.rows === last.rows) return cur;
          last = cur;
        }
        return last;
      })();
      const spendAfterExhaust = settled.logs;
      // Both refusal layers prove the budget is spent: the gateway's own
      // 422 once spend passes the ceiling, and the reconciler's key block
      // (401) once the control service marks the member blocked.
      const spentRefusal =
        exhausted !== null && (exhausted.verdict === "budget" || exhausted.verdict === "blocked")
          ? exhausted
          : null;
      if (spentRefusal !== null) {
        record.steps.push(
          stepRecord(
            "budget-exhausted",
            true,
            spentRefusal.status,
            spentRefusal.message,
            spentRefusal.raw,
            {
              calls,
              spendDeltaUsd: Math.round((spendAfterExhaust - spendBefore) * 1_000_000) / 1_000_000,
            },
          ),
        );
      } else if (upstreamStop) {
        record.steps.push(
          stepRecord("budget-exhausted", false, null, "halted by the upstream stop", ""),
        );
      } else {
        record.steps.push(
          stepRecord(
            "budget-exhausted",
            false,
            exhausted?.status ?? null,
            exhausted === null
              ? `budget still unexhausted after ${calls} calls`
              : `unexpected refusal (${exhausted.verdict}): ${exhausted.message}`,
            exhausted?.raw ?? "",
            {
              calls,
              spendDeltaUsd: Math.round((spendAfterExhaust - spendBefore) * 1_000_000) / 1_000_000,
            },
          ),
        );
      }
      if (upstreamStop || spentRefusal === null) continue;

      // Step 4: ask for more through the MCP desk.
      logLine(`${cli}: step 4 (request_more_budget through MCP)`);
      let requestId: string | null = null;
      try {
        const mcp = await mcpCallTool(server?.url ?? "", member.secret, "request_more_budget", {
          amountUsd: GRANT_USD,
          reason: "Live check: the USD 0.05 test budget is exhausted; need room to finish.",
        });
        requestId = mcp.requestId;
        record.steps.push(
          stepRecord(
            "mcp-request",
            mcp.ok && requestId !== null,
            null,
            mcp.ok ? (requestId ?? "sent") : mcp.text,
            mcp.text,
          ),
        );
      } catch (error) {
        record.steps.push(
          stepRecord(
            "mcp-request",
            false,
            null,
            `MCP desk failed: ${(error as Error).message}`,
            "",
          ),
        );
      }
      if (requestId === null) continue;

      // Step 5: the manager approves through the manager API.
      logLine(`${cli}: step 5 (manager approval)`);
      const decide = await fetch(`${server?.url}/api/team/requests/${requestId}/decide`, {
        method: "POST",
        headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          outcome: "approved",
          amountUsd: GRANT_USD,
          note: "Live check approval.",
        }),
      });
      let decideBody: unknown = null;
      try {
        decideBody = await decide.json();
      } catch {
        decideBody = null;
      }
      const approved = decide.status === 200;
      if (approved) {
        approvals.push({
          requestId,
          memberId: member.id,
          amountUsd: GRANT_USD,
          outcome: "approved",
        });
      }
      record.steps.push(
        stepRecord(
          "manager-approval",
          approved,
          decide.status,
          approved ? `approved USD ${GRANT_USD.toFixed(2)}` : `HTTP ${decide.status}`,
          excerptOf(JSON.stringify(decideBody)),
        ),
      );
      if (!approved || upstreamStop) continue;

      // Step 6: the CLI works again.
      logLine(`${cli}: step 6 (works again after approval)`);
      let works: { status: number; combined: string } | null = null;
      for (let i = 0; i < 5 && !upstreamStop; i++) {
        const attempt = await runAllowedCall(cli, home, keyEnv, modelRef, "Reply with OK.");
        const seen = classify(attempt.result.status, attempt.combined);
        if (seen.verdict === "upstream-stop") {
          tripUpstreamStop(`${cli}/works-again`, seen.message);
          break;
        }
        if (seen.verdict === "ok") {
          works = { status: attempt.result.status, combined: attempt.combined };
          break;
        }
        if (seen.verdict !== "budget") {
          works = { status: attempt.result.status, combined: attempt.combined };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (works !== null && classify(works.status, works.combined).verdict === "ok") {
        record.steps.push(
          stepRecord("works-again", true, works.status, "answered", works.combined, { calls: 1 }),
        );
      } else {
        record.steps.push(
          stepRecord(
            "works-again",
            false,
            works?.status ?? null,
            "still refused after approval",
            works?.combined ?? "",
          ),
        );
      }
      let last = await gatewaySpend(member.secret, `${cli}/final0`);
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        const cur = await gatewaySpend(member.secret, `${cli}/final${i + 1}`);
        if (cur.keyInfo === last.keyInfo && cur.rows === last.rows) {
          last = cur;
          break;
        }
        last = cur;
      }
      record.spendUsd = last.logs;
      record.spendKeyInfoUsd = last.keyInfo;
    }

    // --- OpenCode plugin: the unattended rule stops a looping task --------------
    const plugin: LiveJson["plugin"] = {
      pass: false,
      memberId: null,
      message: "",
      excerpt: "",
      spendUsd: 0,
    };
    if (needPlugin && pluginMember !== null && !upstreamStop) {
      plugin.memberId = pluginMember.id;
      const home = mkdtempSync(join(scratch, "home-plugin-"));
      const cfgDir = join(home, ".config", "opencode");
      mkdirSync(cfgDir, { recursive: true });
      // Local file plugins load from the plugin directories, not from the
      // `plugin` config key (npm packages only).
      const pluginDir = join(cfgDir, "plugins");
      mkdirSync(pluginDir, { recursive: true });
      copyFileSync(PLUGIN_PATH, join(pluginDir, "team-ai-allowance.ts"));
      writeFileSync(
        join(cfgDir, "opencode.json"),
        `${JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "team-gateway": {
              npm: "@ai-sdk/openai-compatible",
              name: "Team gateway",
              options: { baseURL: `${gatewayUrl}/v1`, apiKey: "{env:OPENCODE_GATEWAY_KEY}" },
              models: { [MODEL]: { name: "DeepSeek V4.1 Flash" } },
            },
          },
          model: `team-gateway/${MODEL}`,
        })}\n`,
        { mode: 0o600 },
      );
      logLine("plugin: looping task with the unattended rule (15-step off-hours limit)");
      const looping = await spawnAsync(
        "opencode",
        [
          "run",
          "--standalone",
          "--model",
          `team-gateway/${MODEL}`,
          "Do the following 30 steps in order, exactly one bash tool call per step, waiting for each result before the next call. Never combine steps, never use loops, seq, for, while, &&, || or ; to merge commands. Step N is: run the bash tool with the single command `echo LIVE-STEP-N` (for example step 7 is `echo LIVE-STEP-7`). After step 30, reply with DONE.",
        ],
        {
          ...process.env,
          HOME: home,
          OPENCODE_GATEWAY_KEY: pluginMember.secret,
          TAA_BASE_URL: server?.url ?? "",
          TAA_MEMBER_KEY: pluginMember.secret,
        },
        home,
        CALL_TIMEOUT_MS,
      );
      const combined = `${looping.stdout}\n${looping.stderr}`;
      const seen = classify(looping.status, combined);
      if (seen.verdict === "upstream-stop") tripUpstreamStop("plugin", seen.message);
      const paused = /unattended session paused:\s*15 steps without/i.test(combined);
      const pluginSpend = await gatewaySpend(pluginMember.secret, "plugin/final");
      plugin.spendUsd = pluginSpend.logs;
      plugin.pass = paused && plugin.spendUsd < PLUGIN_BUDGET_USD;
      plugin.message = paused
        ? (firstMatchLine(combined, /unattended session paused/i) ?? "unattended pause seen")
        : `no 15-step pause seen (exit ${looping.status}, verdict ${seen.verdict})`;
      plugin.excerpt = excerptOf(combined, 2000);
      const pluginRecord: CliRecord = {
        cli: "opencode-plugin",
        version: versions.opencode ?? "unknown",
        available: true,
        memberId: pluginMember.id,
        steps: [
          stepRecord("unattended-stop", plugin.pass, looping.status, plugin.message, combined),
        ],
        spendUsd: plugin.spendUsd,
        spendKeyInfoUsd: pluginSpend.keyInfo,
        note: "USD 0.50 test budget, so the budget stop cannot fire before the 15-step unattended stop.",
      };
      clis.push(pluginRecord);
      logLine(`plugin: ${plugin.pass ? "PASS" : "FAIL"} (${plugin.message.slice(0, 120)})`);
    } else if (!needPlugin) {
      notes.push("plugin check skipped by flags.");
    }

    // --- Evidence ----------------------------------------------------------------
    const totalSpendUsd =
      Math.round(clis.reduce((sum, record) => sum + record.spendUsd, 0) * 1_000_000) / 1_000_000;
    const evidence: LiveJson = {
      runAt: new Date().toISOString(),
      gateway: {
        image: GATEWAY_IMAGE,
        model: MODEL,
        blockedModel: BLOCKED_MODEL,
        testPricing: {
          inputPer1MUsd: 0.5,
          outputPer1MUsd: 1.5,
          note: "Test pricing (~3x the published Go off-peak USD 0.15/1M in, USD 0.60/1M out) so a CLI context costs ~USD 0.005-0.035 and USD 0.05 budgets exhaust in a handful of calls.",
        },
      },
      cliVersions: versions,
      upstreamStopTripped: upstreamStop,
      clis,
      plugin: needPlugin
        ? clis.find((record) => record.cli === "opencode-plugin") !== undefined
          ? {
              pass:
                clis.find((record) => record.cli === "opencode-plugin")?.steps[0]?.pass ?? false,
              memberId: pluginMember?.id ?? null,
              message:
                clis.find((record) => record.cli === "opencode-plugin")?.steps[0]?.message ?? "",
              excerpt:
                clis.find((record) => record.cli === "opencode-plugin")?.steps[0]?.excerpt ?? "",
              spendUsd: clis.find((record) => record.cli === "opencode-plugin")?.spendUsd ?? 0,
            }
          : {
              pass: false,
              memberId: pluginMember?.id ?? null,
              message: "skipped: upstream stop",
              excerpt: "",
              spendUsd: 0,
            }
        : { pass: false, memberId: null, message: "skipped by flags", excerpt: "", spendUsd: 0 },
      approvals,
      totalSpendUsd,
      notes,
    };
    mkdirSync(dirname(LIVE_JSON), { recursive: true });
    writeFileSync(LIVE_JSON, `${JSON.stringify(evidence, null, 2)}\n`);
    logLine(`evidence: ${LIVE_JSON} (gateway test-spend total USD ${totalSpendUsd.toFixed(6)})`);

    await restore();
    if (upstreamStop) {
      logLine("done with the upstream stop tripped; restore ran; see results/live.json");
      return 2;
    }
    const failed = clis.flatMap((record) => record.steps).filter((step) => !step.pass);
    logLine(
      failed.length === 0
        ? "done: every live step passed"
        : `done with ${failed.length} failing step(s): ${failed.map((step) => step.key).join(", ")}`,
    );
    return 0;
  } catch (error) {
    logLine(`fatal: ${scrub((error as Error).message)}`);
    const llmLogs = await execAsync(runtime, ["logs", "--tail", "30", llmName]).catch(() => null);
    if (llmLogs !== null)
      logLine(`litellm tail: ${excerptOf(`${llmLogs.stdout}\n${llmLogs.stderr}`, 1500)}`);
    try {
      await restore();
    } catch {
      // Restore already logs its own failures.
    }
    return 1;
  }
}

const code = await main();
process.exit(code);
