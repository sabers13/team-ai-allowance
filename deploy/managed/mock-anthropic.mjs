/**
 * A tiny Anthropic Messages mock for the container check.
 *
 * Answers `/v1/messages` in JSON or SSE, records the model and whether an
 * Authorization header arrived, and never reaches a real provider.
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? "4020");
const log = process.env.MOCK_LOG ?? "/tmp/mock-requests.log";

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = {};
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  appendFileSync(
    log,
    `${JSON.stringify({
      url: request.url,
      model: parsed.model ?? null,
      auth: request.headers.authorization
        ? "bearer"
        : request.headers["x-api-key"]
          ? "x-api-key"
          : "none",
    })}\n`,
  );

  if (pathname.endsWith("/v1/messages/count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 1 }));
    return;
  }

  if (!pathname.endsWith("/v1/messages")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "not_found", message: "mock" } }));
    return;
  }

  const model = parsed.model ?? "mock-model";
  const message = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  if (parsed.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "OK" },
    });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    send("message_stop", { type: "message_stop" });
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(message));
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`mock anthropic listening on ${port}\n`);
});
