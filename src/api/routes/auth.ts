/**
 * Session routes: CSRF bootstrap, login, logout and session inspection.
 *
 * Login accepts either an e-mail and password (manager or admin) or a member
 * gateway key (member only). A manager key is refused here: managers use a
 * password. Every login attempt is rate-limited per IP and every failure is
 * reported with the same message, so the route never reveals which accounts
 * exist.
 */

import {
  CSRF_COOKIE,
  clearedCookie,
  hashPassword,
  newLoginCsrfToken,
  parseCookieHeader,
  SESSION_COOKIE,
  serializeCookie,
  signSessionCookie,
  verifyLoginCsrf,
  verifyPassword,
} from "../../auth/index.ts";
import type { ApiDependencies } from "../deps.ts";
import { badRequest, forbidden, rateLimited, unauthorized } from "../errors.ts";
import { requirePrincipal } from "../guard.ts";
import { getHeader, originAllowed } from "../http.ts";
import type { Router } from "../router.ts";
import { objectBody, optionalString } from "../validate.ts";

const GENERIC_LOGIN_FAILURE = "E-mail or password is incorrect.";
const KEY_LOGIN_FAILURE = "That key cannot sign in here.";

export function registerAuthRoutes(router: Router, deps: ApiDependencies): void {
  const secure = deps.config.cookieSecure;
  const csrfCookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "Strict" as const,
    path: "/",
    maxAgeSeconds: 60 * 60,
  };
  const sessionCookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "Strict" as const,
    path: "/",
    maxAgeSeconds: Math.floor(deps.config.sessionTtlMs / 1000),
  };

  let dummyPasswordHash: string | null = null;
  const dummyHash = async (): Promise<string> => {
    dummyPasswordHash ??= await hashPassword("not-a-real-password");
    return dummyPasswordHash;
  };

  router.add("GET", "/api/auth/csrf", "public", () => {
    const token = newLoginCsrfToken();
    return {
      status: 200,
      body: { csrfToken: token },
      cookies: [serializeCookie(CSRF_COOKIE, token, csrfCookieOptions)],
    };
  });

  router.add("POST", "/login", "public", async (context) => {
    if (!originAllowed(context.request, deps.config.publicUrl)) {
      throw forbidden("Cross-origin request refused.");
    }
    const cookies = parseCookieHeader(getHeader(context.request, "cookie"));
    const body = objectBody(context.body);
    const provided = optionalString(body, "_csrf", { maxLength: 200 });
    if (!verifyLoginCsrf(cookies[CSRF_COOKIE], provided)) {
      throw forbidden("CSRF token is missing or invalid.");
    }

    const limit = deps.limiter.check(context.ip);
    if (limit.limited) throw rateLimited(limit.retryAfterSeconds);

    const fail = (message: string): never => {
      deps.limiter.recordFailure(context.ip);
      throw unauthorized(message);
    };

    const memberKey = optionalString(body, "memberKey", { minLength: 8, maxLength: 400 });
    const email = optionalString(body, "email", { minLength: 3, maxLength: 320 });
    const password = optionalString(body, "password", { minLength: 1, maxLength: 200 });

    let memberId: string;
    let teamId: string;
    let role: "member" | "manager" | "admin";

    if (memberKey !== undefined) {
      const principal = await deps.authenticator.authenticate({
        authorization: `Bearer ${memberKey}`,
        cookie: undefined,
      });
      if (principal === null || principal.kind !== "member_key") {
        return fail(KEY_LOGIN_FAILURE);
      }
      if (principal.member.role !== "member") {
        return fail(KEY_LOGIN_FAILURE);
      }
      memberId = principal.member.id;
      teamId = principal.member.teamId;
      role = "member";
    } else if (email !== undefined && password !== undefined) {
      const credential = await deps.credentials.findByEmail(email);
      if (credential === null) {
        await verifyPassword(password, await dummyHash());
        return fail(GENERIC_LOGIN_FAILURE);
      }
      const valid = await verifyPassword(password, credential.passwordHash);
      const member = valid ? await deps.control.getMember(credential.memberId) : null;
      if (!valid || member === null || member.role === "member") {
        return fail(GENERIC_LOGIN_FAILURE);
      }
      memberId = member.id;
      teamId = member.teamId;
      role = member.role;
    } else {
      throw badRequest("Provide an e-mail and password, or a member key.");
    }

    deps.limiter.clear(context.ip);
    const session = deps.sessions.create({
      memberId,
      teamId,
      role,
      ttlMs: deps.config.sessionTtlMs,
    });
    const member = await deps.control.getMember(memberId);
    if (member === null) return fail(GENERIC_LOGIN_FAILURE);
    return {
      status: 200,
      body: {
        user: {
          id: member.id,
          displayName: member.displayName,
          email: member.email,
          role,
          teamId,
        },
        csrfToken: session.csrfToken,
      },
      cookies: [
        serializeCookie(
          SESSION_COOKIE,
          signSessionCookie(session, deps.config.sessionSecret),
          sessionCookieOptions,
        ),
      ],
    };
  });

  router.add("POST", "/logout", "member", (context) => {
    const principal = requirePrincipal(context);
    if (principal.kind === "session") deps.sessions.destroy(principal.sessionId);
    return {
      status: 200,
      body: { loggedOut: true },
      cookies: [
        clearedCookie(SESSION_COOKIE, { ...sessionCookieOptions, httpOnly: true }),
        clearedCookie(CSRF_COOKIE, csrfCookieOptions),
      ],
    };
  });

  router.add("GET", "/api/session", "member", (context) => {
    const principal = requirePrincipal(context);
    return {
      status: 200,
      body: {
        user: {
          id: principal.member.id,
          displayName: principal.member.displayName,
          email: principal.member.email,
          role: principal.role,
          teamId: principal.member.teamId,
        },
        csrfToken: principal.kind === "session" ? principal.csrfToken : null,
      },
    };
  });
}
