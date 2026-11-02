/**
 * A deliberately small router: method + literal/`:param` path segments.
 *
 * No framework, no dependencies, no middleware chain. The route table is the
 * access-control table: each entry declares who may call it, and the server
 * enforces that before the handler runs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/index.ts";
import { methodNotAllowed, notFound } from "./errors.ts";

export type AuthLevel = "public" | "member" | "manager" | "admin";

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  principal: Principal | null;
  ip: string;
}

export interface RouteResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  cookies?: string[];
}

export type RouteHandler = (context: RequestContext) => Promise<RouteResult> | RouteResult;

interface CompiledRoute {
  method: string;
  pattern: string;
  segments: readonly string[];
  auth: AuthLevel;
  handler: RouteHandler;
}

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export class Router {
  readonly #routes: CompiledRoute[] = [];

  add(method: string, pattern: string, auth: AuthLevel, handler: RouteHandler): this {
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: splitPath(pattern),
      auth,
      handler,
    });
    return this;
  }

  match(method: string, pathname: string): RouteMatch {
    const wanted = method.toUpperCase();
    const parts = splitPath(pathname);
    let pathMatched = false;

    for (const route of this.#routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index];
        const actual = parts[index];
        if (expected === undefined || actual === undefined) {
          matched = false;
          break;
        }
        if (expected.startsWith(":")) {
          const value = decodeSegment(actual);
          if (value.length === 0) {
            matched = false;
            break;
          }
          params[expected.slice(1)] = value;
          continue;
        }
        if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathMatched = true;
      if (route.method !== wanted) continue;
      return { route, params };
    }

    if (pathMatched) throw methodNotAllowed(wanted);
    throw notFound("No such route.");
  }
}
