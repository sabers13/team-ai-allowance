/**
 * The HTTP server: authentication, authorisation, CSRF, routing and JSON.
 *
 * The server holds no policy of its own. Routes are declared with an auth
 * level; this file enforces it before a handler runs, enforces CSRF for
 * cookie-authenticated state changes, and writes one log line per mutation.
 * It never logs a body, a header, a key, a token or a password.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  type Authenticator,
  type AuthMemberSource,
  type CredentialStore,
  createAuthenticator,
  createLoginRateLimiter,
  createMemorySessionStore,
  type LoginRateLimiter,
  type ManagerTokenStore,
  type Principal,
  type SessionStore,
  verifySessionCsrf,
} from "../auth/index.ts";
import type { Clock, Role } from "../contracts.ts";
import { type ApiConfig, loadApiConfig } from "./config.ts";
import type { ControlPort } from "./control.ts";
import type { ApiDependencies } from "./deps.ts";
import { ApiError, asApiError, forbidden, unauthorized } from "./errors.ts";
import {
  clientIp,
  getHeader,
  originAllowed,
  presentedCsrf,
  readBody,
  requestMethod,
  sendError,
  sendJson,
} from "./http.ts";
import type { AuthLevel, RequestContext, RouteResult } from "./router.ts";
import { buildRouter } from "./routes/index.ts";

export interface ApiLogEntry {
  event: "mutation" | "request_failed";
  method: string;
  route: string;
  status: number;
  actorId: string | null;
  role: Role | null;
}

export type ApiLogger = (entry: ApiLogEntry) => void;

export const silentLogger: ApiLogger = () => {};

export interface ApiServerOptions {
  control: ControlPort;
  /** The member source backed by the control store. */
  members: AuthMemberSource;
  credentials: CredentialStore;
  managerTokens: ManagerTokenStore;
  sessions?: SessionStore;
  limiter?: LoginRateLimiter;
  clock?: Clock;
  config?: ApiConfig;
  logger?: ApiLogger;
}

export interface ApiServerHandle {
  server: Server;
  config: ApiConfig;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  /**
   * The request handler, exposed so `taa serve` can mount the API and the
   * console on one port. It is the same function the API server's own
   * `server` uses.
   */
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

function isMutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function authorize(level: AuthLevel, principal: Principal | null): void {
  if (level === "public") return;
  if (principal === null) throw unauthorized();
  if (level === "member") return;
  if (level === "manager") {
    if (principal.role === "member") {
      throw forbidden(
        principal.kind === "member_key"
          ? "A member key cannot call a manager route."
          : "A member cannot call a manager route.",
      );
    }
    return;
  }
  if (principal.role !== "admin") throw forbidden("Admin role required.");
}

export function createApiServer(options: ApiServerOptions): ApiServerHandle {
  const clock = options.clock ?? systemClock;
  const config = options.config ?? loadApiConfig();
  const sessions = options.sessions ?? createMemorySessionStore(clock);
  const limiter =
    options.limiter ??
    createLoginRateLimiter({
      maxAttempts: config.loginMaxAttempts,
      windowMs: config.loginWindowMs,
      clock,
    });
  const logger = options.logger ?? silentLogger;

  const authenticator: Authenticator = createAuthenticator({
    members: options.members,
    tokens: options.managerTokens,
    sessions,
    sessionSecret: config.sessionSecret,
    clock,
  });

  const deps: ApiDependencies = {
    control: options.control,
    authenticator,
    credentials: options.credentials,
    managerTokens: options.managerTokens,
    sessions,
    limiter,
    clock,
    config,
  };
  const router = buildRouter(deps);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = requestMethod(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    let route = "unmatched";
    let principal: Principal | null = null;

    try {
      const match = router.match(method, url.pathname);
      route = match.route.pattern;
      const body = await readBody(request, config.bodyLimitBytes);
      principal = await authenticator.authenticate({
        authorization: getHeader(request, "authorization"),
        cookie: getHeader(request, "cookie"),
      });
      authorize(match.route.auth, principal);

      if (principal !== null && principal.kind === "session" && isMutating(method)) {
        if (!originAllowed(request, config.publicUrl)) {
          throw forbidden("Cross-origin request refused.");
        }
        const session = sessions.get(principal.sessionId);
        if (session === null || !verifySessionCsrf(session, presentedCsrf(request, body))) {
          throw forbidden("CSRF token is missing or invalid.");
        }
      }

      const context: RequestContext = {
        request,
        response,
        url,
        params: match.params,
        query: url.searchParams,
        body,
        principal,
        ip: clientIp(request),
      };
      const result: RouteResult = await match.route.handler(context);
      sendJson(response, {
        status: result.status ?? 200,
        body: result.body,
        ...(result.headers === undefined ? {} : { headers: result.headers }),
        ...(result.cookies === undefined ? {} : { cookies: result.cookies }),
      });
      if (principal !== null && isMutating(method)) {
        logger({
          event: "mutation",
          method,
          route,
          status: result.status ?? 200,
          actorId: principal.member.id,
          role: principal.role,
        });
      }
    } catch (error) {
      const apiError = asApiError(error);
      if (!(error instanceof ApiError)) {
        logger({
          event: "request_failed",
          method,
          route,
          status: apiError.status,
          actorId: principal === null ? null : principal.member.id,
          role: principal === null ? null : principal.role,
        });
      }
      sendError(response, apiError);
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendError(response, asApiError(undefined));
      else response.end();
    });
  });

  return { server, config, sessions, limiter, handle };
}

/** The clock used when a caller does not inject one. */
export function currentClock(): Clock {
  return systemClock;
}
