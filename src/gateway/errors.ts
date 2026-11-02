/**
 * Typed errors for the LiteLLM admin client.
 *
 * Every failure leaves the client as a `GatewayError` with a stable `code`, so
 * callers never branch on an HTTP status or a provider message. The control
 * service maps `budget_exceeded` and `model_access_denied` to the sentences a
 * member sees; the raw gateway body is only ever used to build the message.
 *
 * No error ever carries a credential. `redactSecrets()` runs on every message
 * that came from the gateway, and the client never puts its headers or the
 * master key into an error.
 */

export type GatewayErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "budget_exceeded"
  | "model_access_denied"
  | "rate_limited"
  | "upstream_error"
  | "network_error"
  | "invalid_response";

export interface GatewayErrorOptions {
  readonly status?: number | null;
  /** The gateway's `error.type`, when it sent one. */
  readonly type?: string | null;
  /** Safe, redacted detail from the gateway body. */
  readonly details?: string | null;
  readonly cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number | null;
  readonly type: string | null;
  readonly details: string | null;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(redactSecrets(message));
    this.name = "GatewayError";
    this.code = code;
    this.status = options.status ?? null;
    this.type = options.type ?? null;
    this.details =
      options.details === undefined || options.details === null
        ? null
        : redactSecrets(options.details);
    if (options.cause !== undefined) this.cause = redactSecretObject(options.cause);
  }

  /** True when retrying the same call could succeed without a change. */
  get retryable(): boolean {
    return (
      this.code === "network_error" ||
      this.code === "upstream_error" ||
      this.code === "rate_limited"
    );
  }
}

/** Missing or invalid client configuration. Never includes the value. */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

const KEY_PATTERN = /\bsk-[A-Za-z0-9._-]{4,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const HEX_SECRET_PATTERN = /\b[0-9a-f]{64}\b/g;

/** Remove credential-shaped text before it can reach a log or an error. */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(KEY_PATTERN, "sk-[redacted]")
    .replace(HEX_SECRET_PATTERN, "[redacted-hash]");
}

function redactSecretObject(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message));
    copy.name = value.name;
    return copy;
  }
  return value;
}

interface ErrorEnvelope {
  readonly message: string | null;
  readonly type: string | null;
}

/** Pull `error.message` / `error.type` out of a LiteLLM error body. */
export function readErrorEnvelope(body: unknown): ErrorEnvelope {
  if (typeof body !== "object" || body === null) return { message: null, type: null };
  const error = (body as Record<string, unknown>).error;
  if (typeof error === "string") return { message: error, type: null };
  if (typeof error !== "object" || error === null) return { message: null, type: null };
  const record = error as Record<string, unknown>;
  return {
    message: typeof record.message === "string" ? record.message : null,
    type: typeof record.type === "string" ? record.type : null,
  };
}

/**
 * Map an HTTP failure from the admin or inference surface.
 *
 * For LiteLLM v1.105.1, a budget refusal is
 * 422 with `error.type = budget_exceeded`; a key model list refusal is 403 with
 * `error.type = key_model_access_denied`.
 */
export function mapHttpError(status: number, body: unknown): GatewayError {
  const { message, type } = readErrorEnvelope(body);
  const detail = message === null ? null : redactSecrets(message);
  const suffix = detail === null ? "" : `: ${detail}`;

  if (type === "budget_exceeded") {
    return new GatewayError("budget_exceeded", `The gateway budget is exhausted${suffix}`, {
      status,
      type,
      details: detail,
    });
  }
  if (type === "key_model_access_denied") {
    return new GatewayError(
      "model_access_denied",
      `The gateway refused this model for the key${suffix}`,
      { status, type, details: detail },
    );
  }
  if (type === "model_access_denied" || type === "team_model_access_denied") {
    return new GatewayError("model_access_denied", `The gateway refused this model${suffix}`, {
      status,
      type,
      details: detail,
    });
  }

  switch (status) {
    case 400:
      return new GatewayError("invalid_request", `The gateway rejected the request${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 401:
      return new GatewayError("unauthorized", `The gateway rejected the credential${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 403:
      return new GatewayError("forbidden", `The gateway refused the action${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 404:
      return new GatewayError("not_found", `The gateway does not know this object${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 409:
      return new GatewayError("conflict", `The gateway reported a conflict${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 422:
      return new GatewayError("invalid_request", `The gateway rejected the value${suffix}`, {
        status,
        type,
        details: detail,
      });
    case 429:
      return new GatewayError("rate_limited", `The gateway rate-limited the call${suffix}`, {
        status,
        type,
        details: detail,
      });
    default:
      if (status >= 500) {
        return new GatewayError("upstream_error", `The gateway failed${suffix}`, {
          status,
          type,
          details: detail,
        });
      }
      return new GatewayError("invalid_request", `The gateway returned HTTP ${status}${suffix}`, {
        status,
        type,
        details: detail,
      });
  }
}
