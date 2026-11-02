/**
 * Error mapping and credential hygiene for the gateway client.
 *
 * The error bodies are the recorded shapes from LiteLLM v1.105.1; the
 * leak test sends a key-shaped string in the gateway's own message and asserts
 * it cannot reach an error.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  GatewayConfigError,
  GatewayError,
  LiteLLMGatewayClient,
  loadGatewayConfig,
  mapHttpError,
  redactSecrets,
} from "../../src/gateway/index.ts";
import { startFakeAdmin } from "./fake-admin.ts";

interface Fixture {
  readonly errors: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/admin-responses.json", import.meta.url), "utf8"),
) as Fixture;

const MASTER_KEY = "sk-test-master";

test("a budget refusal maps to budget_exceeded", () => {
  const error = mapHttpError(422, fixture.errors.budgetExceeded);
  assert.ok(error instanceof GatewayError);
  assert.equal(error.code, "budget_exceeded");
  assert.equal(error.status, 422);
  assert.equal(error.retryable, false);
});

test("a key model refusal maps to model_access_denied", () => {
  const error = mapHttpError(403, fixture.errors.modelAccessDenied);
  assert.equal(error.code, "model_access_denied");
  assert.equal(error.status, 403);
});

test("the remaining statuses map to stable codes", () => {
  assert.equal(mapHttpError(400, null).code, "invalid_request");
  assert.equal(mapHttpError(401, fixture.errors.unauthorized).code, "unauthorized");
  assert.equal(mapHttpError(403, null).code, "forbidden");
  assert.equal(mapHttpError(404, fixture.errors.notFound).code, "not_found");
  assert.equal(mapHttpError(409, null).code, "conflict");
  assert.equal(mapHttpError(422, null).code, "invalid_request");
  assert.equal(mapHttpError(429, null).code, "rate_limited");
  assert.equal(mapHttpError(500, fixture.errors.serverError).code, "upstream_error");
  assert.equal(mapHttpError(500, null).retryable, true);
});

test("a real 422 body from the fake maps through the client", async () => {
  const fake = await startFakeAdmin(() => ({
    status: 422,
    body: fixture.errors.budgetExceeded,
  }));
  try {
    const client = new LiteLLMGatewayClient({ baseUrl: fake.url, masterKey: MASTER_KEY });
    await assert.rejects(
      client.updateKey(
        { keyAlias: "taa-m1", keyHash: "a".repeat(64) },
        {
          keyAlias: "taa-m1",
          models: ["mock-cheap"],
          maxBudgetUsd: 1,
          budgetDuration: "1d",
          tpmLimit: null,
          rpmLimit: null,
          blocked: false,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.code, "budget_exceeded");
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("a key-shaped string in the gateway body is redacted", async () => {
  const fake = await startFakeAdmin(() => ({
    status: 401,
    body: fixture.errors.leaky,
  }));
  try {
    const client = new LiteLLMGatewayClient({ baseUrl: fake.url, masterKey: MASTER_KEY });
    await assert.rejects(client.deleteTeam("team-1"), (caught: unknown) => {
      assert.ok(caught instanceof GatewayError);
      assert.doesNotMatch(caught.message, /sk-leak-123/);
      assert.doesNotMatch(caught.message, /sk-[A-Za-z0-9]{8,}/);
      assert.match(caught.message, /sk-\[redacted\]/);
      assert.doesNotMatch(caught.message, new RegExp(MASTER_KEY));
      assert.ok(caught.details === null || !caught.details.includes("sk-leak-123"));
      return true;
    });
  } finally {
    await fake.close();
  }
});

test("the master key never appears in an error message", async () => {
  const fake = await startFakeAdmin(() => ({ status: 500, body: { error: { message: "boom" } } }));
  try {
    const client = new LiteLLMGatewayClient({ baseUrl: fake.url, masterKey: MASTER_KEY });
    await assert.rejects(client.listTeams(), (caught: unknown) => {
      assert.ok(caught instanceof GatewayError);
      assert.equal(caught.code, "upstream_error");
      assert.doesNotMatch(caught.message, new RegExp(MASTER_KEY));
      assert.doesNotMatch(JSON.stringify(caught), new RegExp(MASTER_KEY));
      return true;
    });
  } finally {
    await fake.close();
  }
});

test("a non-JSON success body is invalid_response", async () => {
  const fake = await startFakeAdmin(() => ({ status: 200, text: "not json" }));
  try {
    const client = new LiteLLMGatewayClient({ baseUrl: fake.url, masterKey: MASTER_KEY });
    await assert.rejects(client.listTeams(), (caught: unknown) => {
      assert.ok(caught instanceof GatewayError);
      assert.equal(caught.code, "invalid_response");
      return true;
    });
  } finally {
    await fake.close();
  }
});

test("an unreachable gateway is a network_error", async () => {
  const client = new LiteLLMGatewayClient({
    baseUrl: "http://127.0.0.1:9",
    masterKey: MASTER_KEY,
    timeoutMs: 2000,
  });
  await assert.rejects(client.listTeams(), (caught: unknown) => {
    assert.ok(caught instanceof GatewayError);
    assert.equal(caught.code, "network_error");
    assert.equal(caught.retryable, true);
    return true;
  });
});

test("redactSecrets removes keys, bearer headers and hashes", () => {
  assert.equal(redactSecrets("sk-abc12345"), "sk-[redacted]");
  assert.equal(redactSecrets("Bearer abcdef123456"), "Bearer [redacted]");
  assert.equal(redactSecrets("a".repeat(64)), "[redacted-hash]");
  assert.equal(redactSecrets("nothing to hide"), "nothing to hide");
});

test("loadGatewayConfig validates without echoing a value", () => {
  assert.throws(() => loadGatewayConfig({}), GatewayConfigError);
  assert.throws(
    () => loadGatewayConfig({ LITELLM_MASTER_KEY: "not-a-key" }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayConfigError);
      assert.doesNotMatch(error.message, /not-a-key/);
      return true;
    },
  );
  assert.throws(
    () => loadGatewayConfig({ LITELLM_MASTER_KEY: "sk-test-master", TAA_GATEWAY_URL: "not a url" }),
    GatewayConfigError,
  );
  const config = loadGatewayConfig({ LITELLM_MASTER_KEY: "sk-test-master" });
  assert.equal(config.baseUrl, "http://127.0.0.1:14000");
  const custom = loadGatewayConfig({
    LITELLM_MASTER_KEY: "sk-test-master",
    TAA_GATEWAY_URL: "http://litellm:4000/",
    TAA_GATEWAY_TIMEOUT_MS: "2500",
  });
  assert.equal(custom.baseUrl, "http://litellm:4000");
  assert.equal(custom.timeoutMs, 2500);
});
