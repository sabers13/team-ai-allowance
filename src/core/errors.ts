/**
 * Typed domain errors.
 *
 * Every refusal the core makes is one of these, so the HTTP layer and the
 * MCP layer can map a code to a status without inspecting a message. The
 * message is safe to show to a person: it never contains a key, a token or
 * model output.
 */

export type DomainErrorCode =
  | "invalid_input"
  | "invalid_state"
  | "not_found"
  | "forbidden"
  | "expired"
  | "conflict"
  | "gateway_failure";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function invalidInput(
  message: string,
  details: Record<string, unknown> | null = null,
): never {
  throw new DomainError("invalid_input", message, details);
}

export function invalidState(
  message: string,
  details: Record<string, unknown> | null = null,
): never {
  throw new DomainError("invalid_state", message, details);
}

export function notFound(message: string, details: Record<string, unknown> | null = null): never {
  throw new DomainError("not_found", message, details);
}

export function forbidden(message: string): never {
  throw new DomainError("forbidden", message);
}

export function conflict(message: string, details: Record<string, unknown> | null = null): never {
  throw new DomainError("conflict", message, details);
}

export function gatewayFailure(
  message: string,
  details: Record<string, unknown> | null = null,
): never {
  throw new DomainError("gateway_failure", message, details);
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
