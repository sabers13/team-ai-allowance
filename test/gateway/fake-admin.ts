/**
 * A recorded fake of the LiteLLM admin API.
 *
 * Each test maps a path to a recorded response. The fake records the method,
 * path, query and JSON body of every request, so a contract test can assert
 * exactly what the client sent. It never reaches the network: it binds
 * 127.0.0.1 on a free port.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

export interface FakeReply {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text; used to test a non-JSON body. */
  readonly text?: string;
}

export type FakeHandler = (call: RecordedCall) => FakeReply | Promise<FakeReply>;

export interface FakeAdmin {
  readonly url: string;
  readonly calls: RecordedCall[];
  close(): Promise<void>;
}

type JsonObject = Record<string, unknown>;

async function readJson(request: IncomingMessage): Promise<JsonObject | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return null;
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : null;
}

function queryOf(url: string): Record<string, string> {
  const parsed = new URL(url, "http://127.0.0.1");
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) query[key] = value;
  return query;
}

export async function startFakeAdmin(handler: FakeHandler): Promise<FakeAdmin> {
  const calls: RecordedCall[] = [];
  let server: Server;

  server = createServer((request, response) => {
    readJson(request)
      .then(async (body) => {
        const call: RecordedCall = {
          method: request.method ?? "GET",
          path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
          query: queryOf(request.url ?? "/"),
          headers: {
            authorization:
              typeof request.headers.authorization === "string"
                ? request.headers.authorization
                : "",
            "content-type":
              typeof request.headers["content-type"] === "string"
                ? request.headers["content-type"]
                : "",
          },
          body,
        };
        calls.push(call);
        const reply = await handler(call);
        const text = reply.text ?? JSON.stringify(reply.body ?? {});
        response.writeHead(reply.status ?? 200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(text),
        });
        response.end(text);
      })
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : "fake admin error" },
          }),
        );
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake admin: no TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Build a handler from a path → reply table. Unknown paths answer 404. */
export function routeTable(table: Readonly<Record<string, FakeReply | unknown>>): FakeHandler {
  return (call) => {
    const reply = table[call.path];
    if (reply === undefined) {
      return { status: 404, body: { error: { message: "no recorded reply", type: "not_found" } } };
    }
    if (typeof reply === "object" && reply !== null && "status" in reply) {
      return reply as FakeReply;
    }
    return { body: reply };
  };
}
