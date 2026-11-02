/**
 * API configuration.
 *
 * This is the only file in `src/api/` that reads `process.env`; the rest takes
 * an `ApiConfig`. Secrets are validated for presence and length and are never
 * echoed in an error message.
 */

import { SESSION_TTL_MS } from "../auth/index.ts";

export interface ApiConfig {
  /** Absolute base URL used for links and the Origin check. */
  publicUrl: string;
  sessionSecret: string;
  csrfSecret: string;
  /** `Secure` on cookies; true by default when the public URL is https. */
  cookieSecure: boolean;
  sessionTtlMs: number;
  bodyLimitBytes: number;
  loginMaxAttempts: number;
  loginWindowMs: number;
}

export const DEFAULT_PUBLIC_URL = "http://127.0.0.1:18080";
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_LOGIN_MAX_ATTEMPTS = 10;
export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface ApiConfigInput {
  sessionSecret: string;
  csrfSecret: string;
  publicUrl?: string;
  cookieSecure?: boolean;
  sessionTtlMs?: number;
  bodyLimitBytes?: number;
  loginMaxAttempts?: number;
  loginWindowMs?: number;
}

function requireSecret(name: string, value: string | undefined): string {
  if (value === undefined || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be set to at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return value;
}

/** Build a validated config from explicit values (used by tests and `serve`). */
export function createApiConfig(input: ApiConfigInput): ApiConfig {
  const publicUrl = input.publicUrl ?? DEFAULT_PUBLIC_URL;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("TAA_PUBLIC_URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TAA_PUBLIC_URL must be an absolute http(s) URL.");
  }
  const sessionTtlMs = input.sessionTtlMs ?? SESSION_TTL_MS;
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error("sessionTtlMs must be a positive number.");
  }
  return {
    publicUrl: parsed.origin,
    sessionSecret: requireSecret("TAA_SESSION_SECRET", input.sessionSecret),
    csrfSecret: requireSecret("TAA_CSRF_SECRET", input.csrfSecret),
    cookieSecure: input.cookieSecure ?? parsed.protocol === "https:",
    sessionTtlMs,
    bodyLimitBytes: input.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    loginMaxAttempts: input.loginMaxAttempts ?? DEFAULT_LOGIN_MAX_ATTEMPTS,
    loginWindowMs: input.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS,
  };
}

/** Read `TAA_*` environment variables for the HTTP API. */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return createApiConfig({
    sessionSecret: requireSecret("TAA_SESSION_SECRET", env.TAA_SESSION_SECRET),
    csrfSecret: requireSecret("TAA_CSRF_SECRET", env.TAA_CSRF_SECRET),
    publicUrl: env.TAA_PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
  });
}
