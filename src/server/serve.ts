/**
 * `taa serve`: API, console, reconciler and watcher on one port.
 *
 * Composition only. Every use case lives in `src/core/service.ts`, every route
 * in `src/api/` and `src/console/`, and every adapter in `control.ts` and
 * `console.ts` next to this file. This module wires them, answers `/health`
 * and shuts everything down in order.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type ControlPort, createApiServer } from "../api/index.ts";
import type { CredentialStore, ManagerTokenStore, SessionStore } from "../auth/index.ts";
import {
  createMemoryCredentialStore,
  createMemoryManagerTokenStore,
  createMemorySessionStore,
} from "../auth/index.ts";
import { createConsole, type Viewer } from "../console/index.ts";
import type { Clock, GatewayClient } from "../contracts.ts";
import { ControlService, randomIds, systemClock } from "../core/index.ts";
import { LiteLLMGatewayClient } from "../gateway/index.ts";
import { type HintsFile, parseHintsFile } from "../mcp/index.ts";
import { createNotifier, loadNotifyConfig } from "../notify/index.ts";
import { openSqliteStore, type SqliteStore } from "../store/index.ts";
import { Watcher, type WatcherConfig } from "../watcher/index.ts";
import { loadServerConfig, type ServerConfig } from "./config.ts";
import { createConsolePorts, parseCookies, resolveConsoleSession, viewerOf } from "./console.ts";
import { createControlPort } from "./control.ts";
import { type DemoSeedResult, seedDemo } from "./demo.ts";

export interface ControlServerOptions {
  config: ServerConfig;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  logger?: (line: string) => void;
  /** A gateway the server must use; tests pass a fake one here. */
  gateway?: GatewayClient;
}

export interface ControlServerHandle {
  url: string;
  port: number;
  config: ServerConfig;
  store: SqliteStore;
  server: Server;
  control: ControlPort;
  gateway: GatewayClient;
  watcher: Watcher;
  credentials: CredentialStore;
  managerTokens: ManagerTokenStore;
  sessions: SessionStore;
  /** Present when the demo seed ran on this start. */
  demo: DemoSeedResult | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Last known gateway health, refreshed on the interval and on demand. */
  gatewayHealth(): Promise<{ ok: boolean; checkedAt: string }>;
}

const HEALTH_CACHE_MS = 5_000;
const BODY_LIMIT_BYTES = 64 * 1024;

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function headersOf(request: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function isJson(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export async function createControlServer(
  options: ControlServerOptions,
): Promise<ControlServerHandle> {
  const env = options.env ?? process.env;
  const config = options.config;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ids = randomIds();

  const store = openSqliteStore({ path: config.dbPath, clock });
  const gateway =
    options.gateway ??
    new LiteLLMGatewayClient({
      baseUrl: config.gateway.baseUrl,
      masterKey: config.gateway.masterKey,
      timeoutMs: config.gateway.timeoutMs,
    });
  const notifyConfig = loadNotifyConfig(env);
  const service = new ControlService({
    store,
    gateway,
    clock,
    ids,
    publicUrl: config.publicUrl,
    notifyFactory: (policy) =>
      createNotifier({ policy, config: notifyConfig, env, logger: (line) => logger(line) }),
  });
  const credentials = createMemoryCredentialStore(clock);
  const managerTokens = createMemoryManagerTokenStore();
  const sessions = createMemorySessionStore(clock);

  const control = createControlPort({
    store,
    gateway,
    service,
    clock,
    ids,
    controlUrl: config.publicUrl,
    gatewayUrl: config.gateway.baseUrl,
  });

  const hints = await loadHints(env);

  const api = createApiServer({
    control,
    members: store,
    credentials,
    managerTokens,
    sessions,
    clock,
    config: config.api,
    logger: (entry) =>
      logger(
        `api ${entry.event} ${entry.method} ${entry.route} ${entry.status} actor=${entry.actorId ?? "-"} role=${entry.role ?? "-"}`,
      ),
  });

  const watcherConfig: WatcherConfig = {
    intervalMs: config.watchIntervalMs,
    overlapMs: 60_000,
    publicUrl: config.publicUrl,
  };
  const watcher = new Watcher({
    store,
    gateway,
    clock,
    ids,
    config: watcherConfig,
    notifyConfig,
    env,
    logger: (line) => logger(`watcher ${line}`),
    notifyFactory: (policy) =>
      createNotifier({ policy, config: notifyConfig, env, logger: (line) => logger(line) }),
  });
  const reconciler = service.startReconciler({
    intervalMs: config.reconcileIntervalMs,
    onError: (error) => logger(`reconcile-error ${error instanceof Error ? error.name : "Error"}`),
  });
  const expiry = service.startExpiryLoop({
    onError: (error) => logger(`expiry-error ${error instanceof Error ? error.name : "Error"}`),
  });

  let demo: DemoSeedResult | null = null;
  let health = { ok: false, checkedAt: new Date(0).toISOString() };
  let healthCheckedMs = 0;

  async function gatewayHealth(): Promise<{ ok: boolean; checkedAt: string }> {
    const nowMs = Date.now();
    if (nowMs - healthCheckedMs < HEALTH_CACHE_MS) return health;
    const ok = await gateway.healthy().catch(() => false);
    health = { ok, checkedAt: clock.now().toISOString() };
    healthCheckedMs = nowMs;
    return health;
  }

  if (config.bootstrap !== null || config.demoSeed) {
    // A compose start can reach the control service before LiteLLM has run its
    // migrations. Seeding issues keys, so wait for a healthy gateway first.
    const ready = await waitForGateway(gateway, config.gatewayWaitMs, logger);
    if (!ready) {
      logger("serve: gateway still unhealthy after the wait; seeding may be incomplete");
    }
    demo = await seedDemo({
      store,
      control,
      service,
      credentials,
      managerTokens,
      clock,
      ids,
      demo: config.demoSeed,
      managerPassword: config.demoManagerPassword,
      bootstrap: config.bootstrap,
      logger,
    });
  }

  const teamNameCache = new Map<string, string>();

  async function viewerFor(request: IncomingMessage): Promise<Viewer | null> {
    const session = resolveConsoleSession(headersOf(request).cookie, {
      sessions,
      sessionSecret: config.api.sessionSecret,
      clock,
    });
    if (session === null) return null;
    const member = await control.getMember(session.memberId);
    if (member === null) return null;
    let teamName = teamNameCache.get(session.teamId) ?? "";
    if (teamName === "") {
      const team = await control.getTeam(session.teamId);
      teamName = team?.name ?? "";
      if (teamName !== "") teamNameCache.set(session.teamId, teamName);
    }
    return viewerOf(session, member, teamName, clock);
  }

  async function handleConsole(request: IncomingMessage, response: ServerResponse) {
    const cookies = parseCookies(headersOf(request).cookie ?? "");
    const viewer = await viewerFor(request);
    const teamPolicy =
      viewer === null ? null : await control.getTeamPolicy(viewer.teamId).catch(() => null);
    const timeZone = teamPolicy?.offHours.timeZone ?? "Europe/Berlin";
    const remote = request.socket.remoteAddress ?? "unknown";
    const ip = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
    const ports = createConsolePorts(
      {
        control,
        store,
        gateway,
        clock,
        credentials,
        sessions,
        limiter: api.limiter,
        sessionSecret: config.api.sessionSecret,
        cookieSecure: config.api.cookieSecure,
        sessionTtlMs: config.api.sessionTtlMs,
        controlUrl: config.publicUrl,
        gatewayUrl: config.gateway.baseUrl,
        hints: hints?.hints ?? [],
        timeZone,
      },
      viewer,
    );
    const console = createConsole({
      data: ports.data,
      actions: ports.actions,
      auth: ports.auth,
      now: () => clock.now(),
      timeZone,
      gatewayName: "the team gateway",
    });

    const method = (request.method ?? "GET").toUpperCase();
    let form: URLSearchParams | null = null;
    if (method === "POST") {
      const body = await readBody(request, BODY_LIMIT_BYTES);
      const contentType = headersOf(request)["content-type"] ?? "";
      form = contentType.includes("application/x-www-form-urlencoded")
        ? new URLSearchParams(body)
        : new URLSearchParams();
    }

    const result = await console.handle({
      method,
      url: request.url ?? "/",
      headers: headersOf(request),
      form,
      cookies,
      session: viewer,
      ip,
    });

    const headers: Record<string, string> = { ...result.headers };
    const cookiesOut = headers["set-cookie"];
    if (cookiesOut !== undefined) {
      headers["set-cookie"] = cookiesOut;
    }
    response.writeHead(result.status, headers);
    response.end(result.body);
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health") {
      void gatewayHealth().then((gatewayState) => {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(
          `${JSON.stringify({
            status: "ok",
            service: "team-ai-allowance-control",
            schemaVersion: store.schemaVersion(),
            uptimeSeconds: Math.round(process.uptime()),
            gateway: gatewayState,
            intervals: {
              watchMs: config.watchIntervalMs,
              reconcileMs: config.reconcileIntervalMs,
            },
            demo: demo === null ? null : { team: demo.teamId, members: demo.members.length },
          })}\n`,
        );
      });
      return;
    }
    if (isJson(pathname)) {
      void api.handle(request, response);
      return;
    }
    void handleConsole(request, response).catch((error: unknown) => {
      logger(`console-error ${error instanceof Error ? error.name : "Error"}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("The control service could not render that page.\n");
    });
  });

  let stopping = false;

  return {
    url: config.publicUrl,
    port: config.port,
    config,
    store,
    server,
    control,
    gateway,
    watcher,
    credentials,
    managerTokens,
    sessions,
    demo,
    gatewayHealth,
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
      });
      watcher.start();
      reconciler.start();
      expiry.start();
      void expiry.tick();
      void service.reconcile().catch((error: unknown) => {
        logger(`reconcile-error ${error instanceof Error ? error.name : "Error"}`);
      });
      if (config.generatedSecrets) {
        logger("serve: generated local secrets (TAA_DEV_SECRETS=1); not for production");
      }
      logger(`serve: listening on http://${config.host}:${config.port}`);
    },
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      watcher.stop();
      reconciler.stop();
      expiry.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
      store.close();
      logger("serve: stopped");
    },
  };
}

async function waitForGateway(
  gateway: GatewayClient,
  timeoutMs: number,
  logger: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (await gateway.healthy().catch(() => false)) return true;
  logger(`serve: waiting up to ${Math.round(timeoutMs / 1000)}s for the gateway`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await gateway.healthy().catch(() => false)) return true;
  }
  return false;
}

async function loadHints(env: NodeJS.ProcessEnv): Promise<HintsFile | null> {
  const path = env.TAA_HINTS_FILE?.trim();
  if (path === undefined || path.length === 0) return null;
  try {
    return parseHintsFile(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export type { DemoSeedResult };
/** Re-exported so `taa serve` can build a config from a port flag. */
export { loadServerConfig };
