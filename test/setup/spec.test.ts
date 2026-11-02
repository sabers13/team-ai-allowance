import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertEnvSafeKey,
  openAiBaseUrl,
  parseSetupSpec,
  SetupSpecError,
} from "../../src/setup/index.ts";
import { minimalSpec, spec } from "./fixture.ts";

const base = {
  team: {
    name: "Demo",
    gatewayUrl: "https://gateway.example.com",
    providerId: "team-gateway",
    defaultModel: "m",
    models: [{ id: "m", displayName: "M" }],
    controlUrl: "https://allowance.example.com",
    mcp: { command: "taa", args: ["mcp"] },
  },
  member: { id: "mbr_1", displayName: "Ada", email: null },
};

function mutate(patch: (root: typeof base) => void) {
  const copy = structuredClone(base);
  patch(copy);
  return copy;
}

test("a full spec is accepted and trailing slashes are removed", () => {
  const parsed = spec();
  assert.equal(parsed.team.gatewayUrl, "https://gateway.example.com");
  assert.equal(parsed.team.models.length, 2);
  assert.equal(parsed.team.pluginPath, "/etc/opencode/plugins/team-ai-allowance.ts");
  assert.deepEqual(parsed.team.security.allowedSandboxModes, ["read-only", "workspace-write"]);
  assert.equal(parsed.member.email, "ada@example.com");
});

test("optional fields default to null or absent", () => {
  const parsed = minimalSpec();
  assert.equal(parsed.team.pluginPath, null);
  assert.deepEqual(parsed.team.security, {});
  assert.equal(parsed.member.email, null);
});

test("the default model must be in the catalogue", () => {
  const invalid = mutate((root) => {
    root.team.defaultModel = "not-there";
  });
  assert.throws(
    () => parseSetupSpec(invalid),
    (error: unknown) =>
      error instanceof SetupSpecError &&
      error.message === "team.defaultModel: must be one of team.models[].id",
  );
});

test("the model catalogue is required and unique", () => {
  assert.throws(
    () => parseSetupSpec(mutate((root) => (root.team.models = []))),
    /team\.models: must list at least one model/,
  );
  const duplicate = mutate((root) => {
    root.team.models = [
      { id: "m", displayName: "M" },
      { id: "m", displayName: "M again" },
    ];
  });
  assert.throws(() => parseSetupSpec(duplicate), /duplicate model m/);
});

test("URLs and provider ids are validated", () => {
  assert.throws(
    () => parseSetupSpec(mutate((root) => (root.team.gatewayUrl = "gateway.example.com"))),
    /must be an absolute http\(s\) URL/,
  );
  assert.throws(
    () => parseSetupSpec(mutate((root) => (root.team.gatewayUrl = "ftp://gateway.example.com"))),
    /must be an absolute http\(s\) URL/,
  );
  assert.throws(
    () => parseSetupSpec(mutate((root) => (root.team.providerId = "Team Gateway"))),
    /must be lowercase/,
  );
});

test("a plugin path must be absolute", () => {
  const invalid = mutate((root) => {
    Object.assign(root.team, { pluginPath: "relative/plugin.js" });
  });
  assert.throws(() => parseSetupSpec(invalid), /must be an absolute path/);
});

test("the OpenAI base URL gets exactly one /v1 suffix", () => {
  assert.equal(openAiBaseUrl("https://gw.example.com"), "https://gw.example.com/v1");
  assert.equal(openAiBaseUrl("https://gw.example.com/v1"), "https://gw.example.com/v1");
});

test("gateway keys must be safe in a shell-sourced env file", () => {
  assert.equal(assertEnvSafeKey("inert-key-0001"), "inert-key-0001");
  for (const bad of ["", "a b", "a\nb", "a'b", "$(id)"]) {
    assert.throws(() => assertEnvSafeKey(bad), SetupSpecError);
  }
});
