/**
 * Typed API errors and the documented JSON error envelope.
 *
 * Standard JSON error shapes for the HTTP API. Messages are written for a person and
 * never contain credentials, bodies or upstream details.
 */

import { DomainError } from "../core/index.ts";
import { GatewayError } from "../gateway/index.ts";

export type ApiErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "over_limit"
  | "rate_limited"
  | "method_not_allowed"
  | "internal";

export interface ErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    details: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details: unknown = null): ApiError {
  return new ApiError(400, "invalid_input", message, details);
}

export function unauthorized(message = "Authentication required."): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function forbidden(message = "You do not have access to this route."): ApiError {
  return new ApiError(403, "forbidden", message);
}

export function notFound(message = "Not found."): ApiError {
  return new ApiError(404, "not_found", message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}

export function overLimit(message: string): ApiError {
  return new ApiError(422, "over_limit", message);
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError(429, "rate_limited", "Too many attempts. Try again later.", {
    retryAfterSeconds,
  });
}

export function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, "method_not_allowed", `${method} is not allowed on this route.`);
}

export function internalError(): ApiError {
  return new ApiError(500, "internal", "Unexpected server error.");
}

export function errorEnvelope(error: ApiError): ErrorEnvelope {
  return { error: { code: error.code, message: error.message, details: error.details } };
}

const DOMAIN_STATUS: Record<DomainError["code"], { status: number; code: ApiErrorCode }> = {
  invalid_input: { status: 400, code: "invalid_input" },
  invalid_state: { status: 409, code: "conflict" },
  not_found: { status: 404, code: "not_found" },
  forbidden: { status: 403, code: "forbidden" },
  expired: { status: 409, code: "conflict" },
  conflict: { status: 409, code: "conflict" },
  gateway_failure: { status: 500, code: "internal" },
};

/**
 * Normalise anything thrown by a handler into an `ApiError`.
 *
 * `DomainError` from the core service carries a safe message and a code, so it maps
 * to the documented status instead of becoming a generic 500. Anything else is
 * an unexpected error: its message is never shown to the caller.
 */
export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DomainError) {
    const mapped = DOMAIN_STATUS[error.code];
    return new ApiError(
      mapped.status,
      mapped.code,
      error.code === "gateway_failure" ? "The gateway is unavailable." : error.message,
      error.details,
    );
  }
  if (error instanceof GatewayError) {
    return gatewayApiError(error);
  }
  return internalError();
}

const GATEWAY_STATUS: Record<GatewayError["code"], { status: number; code: ApiErrorCode }> = {
  unauthorized: { status: 403, code: "forbidden" },
  forbidden: { status: 403, code: "forbidden" },
  not_found: { status: 404, code: "not_found" },
  conflict: { status: 409, code: "conflict" },
  invalid_request: { status: 422, code: "invalid_input" },
  budget_exceeded: { status: 409, code: "conflict" },
  model_access_denied: { status: 403, code: "forbidden" },
  rate_limited: { status: 429, code: "rate_limited" },
  upstream_error: { status: 502, code: "internal" },
  network_error: { status: 502, code: "internal" },
  invalid_response: { status: 502, code: "internal" },
};

function gatewayApiError(error: GatewayError): ApiError {
  const mapped = GATEWAY_STATUS[error.code];
  return new ApiError(mapped.status, mapped.code, "The gateway refused that change.");
}
