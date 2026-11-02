/**
 * A local fake model provider.
 *
 * It answers the three wire APIs this project needs, in both streaming and
 * non-streaming form:
 *
 * - OpenAI Chat Completions: `POST /v1/chat/completions`
 * - OpenAI Responses: `POST /v1/responses`
 * - Anthropic Messages: `POST /v1/messages`
 *
 * Every answer carries the same fixed usage (`MOCK_USAGE`), so a cost test can
 * predict a request exactly. The server logs only method, path, model and the
 * stream flag; it never logs or stores a request body. No test needs a real
 * provider and no prompt text ever leaves this process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MOCK_MODELS, resolveMockModel } from "./models.ts";
import {
  anthropicEvents,
  anthropicMessage,
  chatChunks,
  chatCompletion,
  responsesEvents,
  responsesResult,
} from "./payloads.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface MockRequestLog {
  readonly method: string;
  readonly path: string;
  readonly model: string | null;
  readonly stream: boolean;
}

export interface MockUpstream {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Metadata only; bodies are never recorded. */
  readonly requests: MockRequestLog[];
  close(): Promise<void>;
}

export interface MockUpstreamOptions {
  /** Defaults to 127.0.0.1. The compose service passes 0.0.0.0. */
  readonly host?: string;
  /** 0 picks a free port. Defaults to 0. */
  readonly port?: number;
}

type JsonObject = Record<string, unknown>;

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendError(response: ServerResponse, status: number, message: string, type: string): void {
  sendJson(response, status, { error: { message, type, param: null, code: String(status) } });
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body is not a JSON object");
  }
  return parsed as JsonObject;
}

function startStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders();
}

function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamEvents(
  response: ServerResponse,
  events: ReadonlyArray<{ event: string; data: unknown }>,
  done = true,
): void {
  startStream(response);
  for (const item of events) writeEvent(response, item.event, item.data);
  if (done) response.write("data: [DONE]\n\n");
  response.end();
}

function streamChat(response: ServerResponse, model: string, includeUsage: boolean): void {
  startStream(response);
  for (const chunk of chatChunks(model, includeUsage)) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function normalizedPath(url: string | undefined): string {
  const path = (url ?? "/").split("?")[0] ?? "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  log: MockRequestLog[],
): Promise<void> {
  const method = request.method ?? "GET";
  const path = normalizedPath(request.url);

  if (method === "GET" && (path === "/health" || path === "/health/liveliness")) {
    sendJson(response, 200, { status: "ok", service: "taa-mock-upstream" });
    return;
  }

  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    sendJson(response, 200, {
      object: "list",
      data: MOCK_MODELS.map((id) => ({ id, object: "model", owned_by: "taa-mock" })),
    });
    return;
  }

  const route = path.replace(/^\/v1/, "");
  const known =
    route === "/chat/completions" ||
    route === "/responses" ||
    route === "/messages" ||
    route === "/messages/count_tokens";
  if (method !== "POST" || !known) {
    sendError(response, 404, `mock upstream: no route for ${method} ${path}`, "not_found");
    return;
  }

  let body: JsonObject;
  try {
    body = await readJson(request);
  } catch (error) {
    sendError(
      response,
      400,
      `mock upstream: ${error instanceof Error ? error.message : "invalid body"}`,
      "invalid_request_error",
    );
    return;
  }

  const model = resolveMockModel(body.model);
  const stream = body.stream === true;
  log.push({ method, path, model, stream });
  if (log.length > 500) log.shift();

  if (route === "/chat/completions") {
    if (stream) {
      const options = body.stream_options;
      const includeUsage =
        typeof options === "object" &&
        options !== null &&
        (options as JsonObject).include_usage === true;
      streamChat(response, model, includeUsage);
    } else {
      sendJson(response, 200, chatCompletion(model));
    }
    return;
  }

  if (route === "/responses") {
    if (stream) streamEvents(response, responsesEvents(model));
    else sendJson(response, 200, responsesResult(model));
    return;
  }

  if (route === "/messages/count_tokens") {
    sendJson(response, 200, { input_tokens: 12 });
    return;
  }

  if (stream) streamEvents(response, anthropicEvents(model), false);
  else sendJson(response, 200, anthropicMessage(model));
}

export async function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const host = options.host ?? "127.0.0.1";
  const requests: MockRequestLog[] = [];
  let server: Server;

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response, requests).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(
        response,
        500,
        `mock upstream: ${error instanceof Error ? error.message : "unexpected error"}`,
        "internal_error",
      );
    });
  };

  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("mock upstream: no TCP address");
  }

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    host,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
