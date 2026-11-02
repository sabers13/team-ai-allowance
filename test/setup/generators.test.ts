import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeManagedMcp,
  claudeManagedSettings,
  codexManagedConfig,
  codexRequirements,
  generateSetupBundle,
  memberEnvFile,
  openCodeConfig,
  tomlString,
} from "../../src/setup/index.ts";
import { KEY, minimalSpec, spec } from "./fixture.ts";

test("Claude managed settings pin the gateway, models and provider", () => {
  const settings = claudeManagedSettings(spec());
  assert.deepEqual(settings.env, { ANTHROPIC_BASE_URL: "https://gateway.example.com" });
  assert.deepEqual(settings.availableModels, ["model-a", "model-b"]);
  assert.deepEqual(settings.allowedProviders, ["customEndpoint"]);
  assert.equal(settings.model, "model-a");
});

test("Claude managed MCP is the exclusive server set", () => {
  const mcp = claudeManagedMcp(spec());
  assert.deepEqual(mcp.mcpServers.taa, {
    type: "stdio",
    command: "taa",
    args: ["mcp"],
    env: {},
  });
});

test("OpenCode allows only the gateway provider and references the key by name", () => {
  const config = openCodeConfig(spec());
  assert.deepEqual(config.enabled_providers, ["team-gateway"]);
  assert.equal(config.model, "team-gateway/model-a");
  assert.equal(config.provider["team-gateway"]?.options.baseURL, "https://gateway.example.com/v1");
  assert.equal(config.provider["team-gateway"]?.options.apiKey, "{env:TAA_MEMBER_KEY}");
  assert.deepEqual(config.provider["team-gateway"]?.models, {
    "model-a": { name: "Model A" },
    "model-b": { name: "Model B" },
  });
  assert.deepEqual(config.mcp.taa, {
    type: "local",
    command: ["taa", "mcp"],
    environment: { TAA_MEMBER_KEY: "{env:TAA_MEMBER_KEY}" },
    enabled: true,
  });
  assert.deepEqual(config.plugin, ["/etc/opencode/plugins/team-ai-allowance.ts"]);
});

test("OpenCode omits the plugin key when the team has no plugin", () => {
  const config = openCodeConfig(minimalSpec());
  assert.equal(config.plugin, undefined);
  assert.equal(config.model, "gw/m");
});

test("Codex requirements hold the MCP allowlist and optional guardrails", () => {
  const text = codexRequirements(spec());
  assert.match(text, /allowed_approval_policies = \["on-request"\]/);
  assert.match(text, /allowed_sandbox_modes = \["read-only", "workspace-write"\]/);
  assert.match(text, /\[mcp_servers\.taa\]/);
  assert.match(text, /identity = \{ command = "taa" \}/);
});

test("Codex requirements omit guardrails the team did not set", () => {
  const text = codexRequirements(minimalSpec());
  assert.doesNotMatch(text, /allowed_approval_policies/);
  assert.doesNotMatch(text, /allowed_sandbox_modes/);
  assert.match(text, /\[mcp_servers\.taa\]/);
});

test("Codex managed config points at the gateway and names the key variable", () => {
  const text = codexManagedConfig(spec());
  assert.match(text, /^model = "model-a"$/m);
  assert.match(text, /^model_provider = "team-gateway"$/m);
  assert.match(text, /^base_url = "https:\/\/gateway\.example\.com\/v1"$/m);
  assert.match(text, /^env_key = "TAA_MEMBER_KEY"$/m);
  assert.match(text, /^wire_api = "responses"$/m);
  assert.match(text, /^\[mcp_servers\.taa\]$/m);
  assert.match(text, /^args = \["mcp"\]$/m);
});

test("TOML strings escape quotes and backslashes", () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
});

test("the member env holds both credential names and nothing else does", () => {
  const env = memberEnvFile(spec(), KEY);
  assert.match(env, new RegExp(`^export ANTHROPIC_AUTH_TOKEN=${KEY}$`, "m"));
  assert.match(env, new RegExp(`^export TAA_MEMBER_KEY=${KEY}$`, "m"));
  assert.match(env, /^export TAA_BASE_URL=https:\/\/allowance\.example\.com$/m);
  assert.match(env, /never commit/);

  const bundle = generateSetupBundle(spec(), KEY);
  for (const file of bundle.files) {
    if (file.path === "member/taa.env") continue;
    assert.equal(file.contents.includes(KEY), false, `key leaked into ${file.path}`);
  }
});

test("the bundle is deterministic and installs five root-owned files", () => {
  const first = generateSetupBundle(spec(), KEY);
  const second = generateSetupBundle(spec(), KEY);
  assert.deepEqual(first, second);

  assert.deepEqual(first.files.map((file) => file.path).sort(), [
    "install.txt",
    "managed/claude-code/managed-mcp.json",
    "managed/claude-code/managed-settings.json",
    "managed/codex/managed_config.toml",
    "managed/codex/requirements.toml",
    "managed/opencode/opencode.json",
    "manifest.json",
    "mdm/ai.opencode.managed.mobileconfig",
    "mdm/com.anthropic.claudecode.mobileconfig",
    "mdm/com.openai.codex.mobileconfig",
    "member/taa.env",
  ]);
  assert.equal(first.install.length, 5);
  assert.ok(first.install.every((entry) => entry.mode === "0644" && entry.owner === "root:root"));
  assert.deepEqual(
    first.install.map((entry) => entry.target),
    [
      "/etc/claude-code/managed-settings.json",
      "/etc/claude-code/managed-mcp.json",
      "/etc/opencode/opencode.json",
      "/etc/codex/requirements.toml",
      "/etc/codex/managed_config.toml",
    ],
  );

  const env = first.files.find((file) => file.path === "member/taa.env");
  assert.equal(env?.mode, 0o600);
});

test("the manifest lists macOS targets without software-managed Codex files", () => {
  const bundle = generateSetupBundle(spec(), KEY);
  const manifest = JSON.parse(
    bundle.files.find((file) => file.path === "manifest.json")?.contents ?? "{}",
  ) as {
    managed: { source: string; targets: { linux: string; macos: string | null } }[];
    memberEnv: { target: string; mode: string };
    models: string[];
  };
  assert.deepEqual(manifest.models, ["model-a", "model-b"]);
  assert.equal(manifest.memberEnv.mode, "0600");
  const codex = manifest.managed.find((entry) => entry.source.endsWith("requirements.toml"));
  assert.equal(codex?.targets.macos, null);
  const claude = manifest.managed.find((entry) => entry.source.endsWith("managed-settings.json"));
  assert.equal(
    claude?.targets.macos,
    "/Library/Application Support/ClaudeCode/managed-settings.json",
  );
});

test("MDM profiles use the documented domains and carry the same policy", () => {
  const bundle = generateSetupBundle(spec(), KEY);
  const get = (path: string) =>
    bundle.files.find((file) => file.path === `mdm/${path}`)?.contents ?? "";

  const claude = get("com.anthropic.claudecode.mobileconfig");
  assert.match(claude, /<string>com\.anthropic\.claudecode<\/string>/);
  assert.match(claude, /<key>availableModels<\/key>/);
  assert.match(claude, /<string>customEndpoint<\/string>/);

  const opencode = get("ai.opencode.managed.mobileconfig");
  assert.match(opencode, /<string>ai\.opencode\.managed<\/string>/);
  assert.match(opencode, /<key>enabled_providers<\/key>/);

  const codex = get("com.openai.codex.mobileconfig");
  assert.match(codex, /<string>com\.openai\.codex<\/string>/);
  const encoded = /<key>requirements_toml_base64<\/key>\s*<string>([^<]+)<\/string>/.exec(codex);
  assert.ok(encoded?.[1], "requirements payload is present");
  assert.match(Buffer.from(encoded[1], "base64").toString("utf8"), /\[mcp_servers\.taa\]/);

  for (const profile of [claude, opencode, codex]) {
    assert.match(profile, /<!DOCTYPE plist/);
    assert.match(profile, /<key>PayloadUUID<\/key>/);
    assert.equal(profile.includes(KEY), false);
  }
});
