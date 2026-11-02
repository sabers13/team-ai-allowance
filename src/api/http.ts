/**
 * HTTP plumbing: headers, cookies, JSON bodies and JSON responses.
 *
 * Bodies are read with a hard size limit, parsed only for JSON and form
 * content types, and never logged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, badRequest, errorEnvelope } from "./errors.ts";

export const JSON_TYPE = "application/json; charset=utf-8";

export function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requestMethod(request: IncomingMessage): string {
  return (request.method ?? "GET").toUpperCase();
}

export function clientIp(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * Read a JSON or form body. Returns `undefined` for an empty body. A missing
 * content type on a body is a 400, not a guess.
 */
export async function readBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  const method = requestMethod(request);
  if (method === "GET" || method === "HEAD") return undefined;

  const declaredLength = getHeader(request, "content-length");
  if (declaredLength !== undefined && Number(declaredLength) > limitBytes) {
    throw new ApiError(413, "invalid_input", "Request body is too large.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limitBytes) {
      throw new ApiError(413, "invalid_input", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;

  const contentType = (getHeader(request, "content-type") ?? "").toLowerCase();
  if (contentType.startsWith("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
    }
  }
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      if (form[key] === undefined) form[key] = value;
    }
    return form;
  }
  throw badRequest("Content-Type must be application/json or application/x-www-form-urlencoded.");
}

export interface ResponseResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  cookies?: string[];
}

export function sendJson(response: ServerResponse, result: ResponseResult): void {
  const payload = JSON.stringify(result.body ?? null);
  response.statusCode = result.status;
  response.setHeader("Content-Type", JSON_TYPE);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value);
  }
  const cookies = result.cookies ?? [];
  if (cookies.length > 0) response.setHeader("Set-Cookie", cookies);
  response.end(payload);
}

export function sendError(response: ServerResponse, error: ApiError): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const headers: Record<string, string> = {};
  if (error.status === 429) {
    const details = error.details;
    if (typeof details === "object" && details !== null && "retryAfterSeconds" in details) {
      const seconds = (details as { retryAfterSeconds: unknown }).retryAfterSeconds;
      if (typeof seconds === "number") headers["Retry-After"] = String(seconds);
    }
  }
  sendJson(response, { status: error.status, body: errorEnvelope(error), headers });
}

/** The CSRF value a request presents, from the header or the body. */
export function presentedCsrf(request: IncomingMessage, body: unknown): string | undefined {
  const header = getHeader(request, "x-csrf-token");
  if (header !== undefined && header.length > 0) return header;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>)._csrf;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Reject a browser request whose Origin is not this service. Requests without
 * an Origin header (curl, MCP, server-to-server) are allowed and still need a
 * bearer credential or a CSRF token.
 */
export function originAllowed(request: IncomingMessage, publicUrl: string): boolean {
  const origin = getHeader(request, "origin");
  if (origin === undefined || origin.length === 0) return true;
  try {
    const parsed = new URL(origin);
    const host = getHeader(request, "host");
    if (host !== undefined && parsed.host === host) return true;
    return parsed.origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
