/**
 * CSRF tokens.
 *
 * - A logged-in session carries one random token, issued with the session and
 *   echoed by every state-changing form as `_csrf` or by API clients as
 *   `X-CSRF-Token`.
 * - The login form uses a double-submit cookie: `GET /api/auth/csrf` sets
 *   `taa_csrf`, and the form must echo the same value. No session exists yet.
 *
 * Both checks are constant-time and fail closed.
 */

import { randomToken, safeEqual } from "./crypto.ts";
import type { Session } from "./session.ts";

export function newLoginCsrfToken(): string {
  return randomToken(32);
}

export function verifyLoginCsrf(
  cookieValue: string | undefined,
  provided: string | undefined,
): boolean {
  if (cookieValue === undefined || provided === undefined) return false;
  if (cookieValue.length === 0 || provided.length === 0) return false;
  return safeEqual(cookieValue, provided);
}

export function verifySessionCsrf(session: Session, provided: string | undefined): boolean {
  if (provided === undefined || provided.length === 0) return false;
  return safeEqual(session.csrfToken, provided);
}
