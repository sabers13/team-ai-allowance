/**
 * Static checks on the compose stack.
 *
 * These cannot prove the containers start (that is `make gateway-it`), but they
 * do hold the facts a reviewer would otherwise have to read by eye: the pinned
 * LiteLLM digest, localhost-only ports with the agreed defaults, container
 * names, prompt storage off and mock-only routes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const compose = readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8");
const litellm = readFileSync(new URL("../../deploy/litellm.config.yaml", import.meta.url), "utf8");

test("LiteLLM is pinned by tag and digest from the verified note", () => {
  assert.match(
    compose,
    /ghcr\.io\/berriai\/litellm:v1\.105\.1@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802/,
  );
});

test("every published host port binds 127.0.0.1 with the agreed default", () => {
  const expected: ReadonlyArray<[string, string]> = [
    ["TAA_GATEWAY_PORT", "14000"],
    ["TAA_POSTGRES_PORT", "15432"],
    ["TAA_CONSOLE_PORT", "18080"],
    ["TAA_MAIL_UI_PORT", "18025"],
    ["TAA_WEBHOOK_PORT", "18090"],
  ];
  for (const [name, port] of expected) {
    assert.ok(
      compose.includes(`127.0.0.1:\${${name}:-${port}}:`),
      `compose must publish ${name} on 127.0.0.1, default ${port}`,
    );
  }
  const published = compose.split("\n").filter((line) => /^\s+- "127\.0\.0\.1:/.test(line));
  for (const line of published) {
    assert.match(line, /127\.0\.0\.1:\$\{TAA_[A-Z_]+:-\d+\}:\d+/, line);
  }
});

test("the services carry the taa- container names", () => {
  for (const name of [
    "taa-postgres",
    "taa-mock-upstream",
    "taa-litellm",
    "taa-control",
    "taa-mail",
    "taa-webhook",
  ]) {
    assert.ok(compose.includes(`container_name: ${name}`), `missing container_name ${name}`);
  }
});

test("LiteLLM reads its master key and database from the environment", () => {
  assert.match(compose, /LITELLM_MASTER_KEY: \$\{LITELLM_MASTER_KEY:\?/);
  assert.match(compose, /DATABASE_URL: postgresql:\/\/litellm:/);
  assert.match(litellm, /master_key: os\.environ\/LITELLM_MASTER_KEY/);
  assert.match(litellm, /database_url: os\.environ\/DATABASE_URL/);
});

test("prompt storage in spend logs is explicitly off", () => {
  assert.match(litellm, /store_prompts_in_spend_logs: false/);
});

test("every model route points at the mock upstream", () => {
  const routes = litellm.match(/api_base: .*/g) ?? [];
  assert.ok(routes.length >= 2);
  for (const route of routes) {
    assert.equal(route, "api_base: http://mock-upstream:4001/v1");
  }
  assert.match(litellm, /model_name: mock-cheap/);
  assert.match(litellm, /model_name: mock-flagship/);
});

test("no stack file carries a real-looking credential", () => {
  for (const text of [compose, litellm]) {
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{20,}\b/);
  }
});
