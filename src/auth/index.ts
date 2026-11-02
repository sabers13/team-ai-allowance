/**
 * Public entry point for `src/auth/`.
 *
 * Other modules import only from this file. It exposes the credential, token
 * and session ports, their in-memory reference implementations, and the
 * request-to-principal resolver. It never exposes stored key or password
 * material.
 */

export type { CookieOptions, SameSite } from "./cookies.ts";
export { clearedCookie, parseCookieHeader, serializeCookie } from "./cookies.ts";
export { safeEqual, sha256Hex } from "./crypto.ts";
export { newLoginCsrfToken, verifyLoginCsrf, verifySessionCsrf } from "./csrf.ts";
export { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
export type {
  AuthenticateRequest,
  Authenticator,
  AuthenticatorOptions,
  AuthMemberSource,
  Principal,
} from "./principal.ts";
export { bearerToken, createAuthenticator } from "./principal.ts";
export type { LoginRateLimiter, LoginRateLimiterOptions, RateLimitState } from "./ratelimit.ts";
export { createLoginRateLimiter } from "./ratelimit.ts";
export type { CreateSessionInput, Session, SessionCookiePayload, SessionStore } from "./session.ts";
export {
  CSRF_COOKIE,
  createMemorySessionStore,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSessionCookie,
  verifySessionCookie,
} from "./session.ts";
export type {
  CredentialStore,
  IssuedManagerToken,
  IssueManagerTokenInput,
  ManagerCredential,
  ManagerTokenRecord,
  ManagerTokenStore,
} from "./stores.ts";
export {
  createMemoryCredentialStore,
  createMemoryManagerTokenStore,
  issueManagerToken,
  MANAGER_TOKEN_PREFIX,
  normalizeEmail,
} from "./stores.ts";
