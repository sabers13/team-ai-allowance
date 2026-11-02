/**
 * Tests for the mock upstream.
 *
 * They prove the three wire APIs work in streaming and non-streaming form,
 * that usage is fixed per request, that the mock never echoes prompt text and
 * that its request log carries metadata only.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  MOCK_MODELS,
  MOCK_USAGE,
  type MockUpstream,
  startMockUpstream,
} from "../../src/mock-upstream/index.ts";

let upstream: MockUpstream;

before(async () => {
  upstream = await startMockUpstream();
});

after(async () => {
  await upstream.close();
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${upstream.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ssePayloads(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => line.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

test("the health and model routes answer", async () => {
  const health = await fetch(`${upstream.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "taa-mock-upstream" });

  const models = await fetch(`${upstream.url}/v1/models`);
  assert.equal(models.status, 200);
  const body = (await models.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((model) => model.id),
    [...MOCK_MODELS],
  );
});

test("Chat Completions returns the fixed usage without echoing the prompt", async () => {
  const response = await post("/v1/chat/completions", {
    model: "mock-cheap",
    messages: [{ role: "user", content: "PROMPT-SHOULD-NOT-ECHO" }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const text = await response.text();
  assert.ok(!text.includes("PROMPT-SHOULD-NOT-ECHO"));
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "mock-cheap");
  const usage = body.usage as Record<string, number>;
  assert.equal(usage.prompt_tokens, MOCK_USAGE.promptTokens);
  assert.equal(usage.completion_tokens, MOCK_USAGE.completionTokens);
  assert.equal(usage.total_tokens, MOCK_USAGE.totalTokens);
});

test("Chat Completions streams and reports usage when asked", async () => {
  const response = await post("/v1/chat/completions", {
    model: "mock-flagship",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const chunks = ssePayloads(await response.text());
  assert.ok(chunks.length >= 4);
  const last = chunks.at(-1);
  assert.ok(last !== undefined);
  assert.deepEqual(last.usage, {
    prompt_tokens: MOCK_USAGE.promptTokens,
    completion_tokens: MOCK_USAGE.completionTokens,
    total_tokens: MOCK_USAGE.totalTokens,
  });
  const content = chunks
    .flatMap(
      (chunk) => (chunk.choices as Array<{ delta?: { content?: string } }> | undefined) ?? [],
    )
    .map((choice) => choice.delta?.content ?? "")
    .join("");
  assert.match(content, /mock response/);
});

test("Responses returns a completed response with fixed usage", async () => {
  const response = await post("/v1/responses", { model: "mock-cheap", input: "ping" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  const usage = body.usage as Record<string, number>;
  assert.equal(usage.input_tokens, MOCK_USAGE.promptTokens);
  assert.equal(usage.output_tokens, MOCK_USAGE.completionTokens);
  const output = body.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 1);
});

test("Responses streams the documented event names", async () => {
  const response = await post("/v1/responses", {
    model: "mock-cheap",
    input: "ping",
    stream: true,
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text
    .split("\n\n")
    .map((block) => block.split("\n")[0] ?? "")
    .filter((line) => line.startsWith("event: "));
  assert.deepEqual(events, [
    "event: response.created",
    "event: response.output_item.added",
    "event: response.content_part.added",
    "event: response.output_text.delta",
    "event: response.output_text.done",
    "event: response.content_part.done",
    "event: response.output_item.done",
    "event: response.completed",
  ]);
  assert.match(text, /"input_tokens":12/);
  assert.match(text, /"output_tokens":7/);
});

test("Anthropic Messages returns a message with fixed usage", async () => {
  const response = await post("/v1/messages", {
    model: "mock-cheap",
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "end_turn");
  const usage = body.usage as Record<string, number>;
  assert.equal(usage.input_tokens, MOCK_USAGE.promptTokens);
  assert.equal(usage.output_tokens, MOCK_USAGE.completionTokens);
  const content = body.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, "text");
});

test("Anthropic Messages streams the documented event names", async () => {
  const response = await post("/v1/messages", {
    model: "mock-cheap",
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text
    .split("\n\n")
    .map((block) => block.split("\n")[0] ?? "")
    .filter((line) => line.startsWith("event: "));
  assert.deepEqual(events, [
    "event: message_start",
    "event: content_block_start",
    "event: content_block_delta",
    "event: content_block_stop",
    "event: message_delta",
    "event: message_stop",
  ]);
  assert.match(text, /"input_tokens":12/);
  assert.match(text, /"output_tokens":7/);
});

test("usage is fixed per request, not cumulative", async () => {
  const first = (await (
    await post("/v1/chat/completions", {
      model: "mock-cheap",
      messages: [{ role: "user", content: "one" }],
    })
  ).json()) as { usage: Record<string, number> };
  const second = (await (
    await post("/v1/chat/completions", {
      model: "mock-cheap",
      messages: [{ role: "user", content: "two" }],
    })
  ).json()) as { usage: Record<string, number> };
  assert.deepEqual(first.usage, second.usage);
  assert.equal(second.usage.total_tokens, 19);
});

test("count_tokens answers with the fixed input count", async () => {
  const response = await post("/v1/messages/count_tokens", {
    model: "mock-cheap",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 12 });
});

test("the request log carries metadata only", async () => {
  await post("/v1/chat/completions", {
    model: "mock-cheap",
    messages: [{ role: "user", content: "PRIVATE-PROMPT" }],
  });
  const log = JSON.stringify(upstream.requests);
  assert.ok(!log.includes("PRIVATE-PROMPT"));
  const entry = upstream.requests.at(-1);
  assert.ok(entry !== undefined);
  assert.deepEqual(Object.keys(entry).sort(), ["method", "model", "path", "stream"]);
  assert.equal(entry.model, "mock-cheap");
});

test("a trailing slash and the unprefixed path both work", async () => {
  assert.equal((await post("/v1/chat/completions/", { model: "mock-cheap" })).status, 200);
  assert.equal((await post("/chat/completions", { model: "mock-cheap" })).status, 200);
});

test("an unknown route is a 404 and an invalid body is a 400", async () => {
  const missing = await fetch(`${upstream.url}/v1/embeddings`, { method: "POST" });
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${upstream.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(invalid.status, 400);
});
