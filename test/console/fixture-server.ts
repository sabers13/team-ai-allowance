/**
 * A local HTTP server around the console handler, for the unit tests and the
 * Playwright suite. It exists only in the test tree: `taa serve` mounts
 * the same handler in the real server.
 *
 * The session is injected for every request by default, so page tests start
 * signed in. `anonymous` gives the sign-in flow an unauthenticated request.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Console, createConsole, createFixtureConsole } from "../../src/console/index.ts";

export interface FixtureServer {
  origin: string;
  console: Console;
  fixture: ReturnType<typeof createFixtureConsole>;
  close(): Promise<void>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== "") cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const fixture = createFixtureConsole();
  const consoleApp = createConsole({
    data: fixture.data,
    actions: fixture.actions,
    auth: fixture.auth,
    now: () => fixture.now,
    timeZone: fixture.timeZone,
    allowSimulation: true,
  });

  const server: Server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const body = request.method === "POST" ? await readBody(request) : "";
      const contentType = headerValue(request.headers["content-type"]) ?? "";
      const form =
        request.method === "POST" && contentType.includes("application/x-www-form-urlencoded")
          ? new URLSearchParams(body)
          : null;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = headerValue(value);
      }
      try {
        const result = await consoleApp.handle({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers,
          form,
          cookies: parseCookies(headerValue(request.headers.cookie)),
          session: fixture.viewer,
        });
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "unexpected error");
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture server has no port");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    console: consoleApp,
    fixture,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
