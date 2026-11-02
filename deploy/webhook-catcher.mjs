/**
 * Generic JSON webhook catcher for the local stack.
 *
 * It accepts any POST, keeps the last 200 bodies in memory and serves them on
 * GET / so a test can assert what the notifier sent. Nothing is written to
 * disk, and request headers are not stored.
 */
import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8090", 10);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS = 200;

/** @type {Array<{at: string, path: string, body: unknown}>} */
const events = [];

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: "[non-JSON body omitted]" };
  }
}

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0] ?? "/";

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "taa-webhook-catcher",
      events: events.length,
    });
    return;
  }

  if (request.method === "GET" && path === "/") {
    sendJson(response, 200, { events });
    return;
  }

  if (request.method === "DELETE" && path === "/") {
    events.length = 0;
    sendJson(response, 200, { cleared: true });
    return;
  }

  if (request.method === "POST") {
    readBody(request)
      .then((body) => {
        events.push({ at: new Date().toISOString(), path, body });
        if (events.length > MAX_EVENTS) events.shift();
        sendJson(response, 200, { received: true, count: events.length });
      })
      .catch((error) => {
        sendJson(response, 413, {
          error: { message: error instanceof Error ? error.message : "invalid body" },
        });
      });
    return;
  }

  sendJson(response, 404, { error: { message: `no route for ${request.method} ${path}` } });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`webhook catcher listening on :${port}\n`);
});
