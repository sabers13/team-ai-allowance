/**
 * `taa doctor` on fixture config homes.
 *
 * Every path honours `HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`,
 * `CODEX_HOME` and `PATH`, so the fixtures stand in for real machines and
 * the real home is never touched. Fixture credentials are inert strings.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeApi, MEMBER_KEY } from "../mcp/harness.ts";
import { runCli } from "./helper.ts";

interface Fixture {
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

function writeScript(bin: string, name: string, version: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
}

/** A home whose three CLIs point at the fake gateway and register taa. */
function makeFixture(fakeUrl: string, withConfigs: boolean): Fixture {
  const home = mkdtempSync(join(tmpdir(), "taa-doctor-"));
  const bin = mkdtempSync(join(tmpdir(), "taa-bin-"));
  writeScript(bin, "claude", "2.1.316 (Claude Code)");
  writeScript(bin, "opencode", "opencode v2.1.3");
  writeScript(bin, "codex", "codex-cli 0.165.0");

  if (withConfigs) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: fakeUrl } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { taa: { command: "taa", args: ["mcp"], env: {} } } }),
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        provider: { "team-gateway": { options: { baseURL: `${fakeUrl}/v1` } } },
        mcp: { taa: { type: "local", command: ["taa", "mcp"] } },
      }),
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `model_provider = "team-gateway"\n[model_providers.team-gateway]\nbase_url = "${fakeUrl}/v1"\n` +
        `[mcp_servers.taa]\ncommand = "taa"\nargs = ["mcp"]\n`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TAA_BASE_URL: fakeUrl,
    TAA_MEMBER_KEY: MEMBER_KEY,
  };
  return { home, bin, env };
}

test("doctor reports a fully pointed setup", async () => {
  const fake = await FakeApi.start();
  try {
    const fixture = makeFixture(fake.url, true);
    const result = await runCli(["doctor"], fixture.env);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      new RegExp(`gateway ${fake.url.replace(/[./]/g, (c) => `\\${c}`)}: reachable`),
    );
    assert.match(result.stdout, /credential accepted/);
    assert.match(result.stdout, /claude 2\.1\.316.*gateway yes.*mcp taa yes/);
    assert.match(result.stdout, /opencode v2\.1\.3.*gateway yes.*mcp taa yes/);
    assert.match(result.stdout, /codex-cli 0\.165\.0.*gateway yes.*mcp taa yes/);
    assert.match(result.stdout, /managed: none/);
    assert.doesNotMatch(result.stdout, new RegExp(MEMBER_KEY));
  } finally {
    await fake.close();
  }
});

test("doctor spots a bare machine", async () => {
  const fake = await FakeApi.start();
  try {
    const fixture = makeFixture(fake.url, false);
    const withoutKey: NodeJS.ProcessEnv = { ...fixture.env };
    delete withoutKey["TAA_MEMBER_KEY"];
    const result = await runCli(["doctor"], withoutKey);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /claude .*mcp taa no/);
    assert.match(result.stdout, /opencode .*mcp taa no/);
    assert.match(result.stdout, /codex .*mcp taa no/);
  } finally {
    await fake.close();
  }
});

test("doctor reports an unreachable gateway", async () => {
  const fixture = makeFixture("http://127.0.0.1:1", true);
  const result = await runCli(["doctor"], fixture.env);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /unreachable/);
});

test("doctor --post sends the report to the service", async () => {
  const fake = await FakeApi.start();
  try {
    const fixture = makeFixture(fake.url, true);
    const result = await runCli(["doctor", "--post"], fixture.env);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /posted/);
    const posted = fake.calls.find((call) => call.path === "/api/me/doctor");
    assert.notEqual(posted, undefined);
  } finally {
    await fake.close();
  }
});

test("doctor honours isolated config dirs", async () => {
  const fake = await FakeApi.start();
  try {
    const fixture = makeFixture(fake.url, false);
    const claudeDir = mkdtempSync(join(tmpdir(), "taa-claude-"));
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: fake.url } }),
    );
    const env: NodeJS.ProcessEnv = { ...fixture.env, CLAUDE_CONFIG_DIR: claudeDir };
    const result = await runCli(["doctor"], env);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /claude 2\.1\.316.*gateway yes/);
  } finally {
    await fake.close();
  }
});

test("doctor never leaks the member key", async () => {
  const fake = await FakeApi.start();
  try {
    const fixture = makeFixture(fake.url, true);
    const keyed: NodeJS.ProcessEnv = { ...fixture.env, TAA_MEMBER_KEY: MEMBER_KEY };
    const result = await runCli(["doctor", "--json"], keyed);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, new RegExp(MEMBER_KEY));
  } finally {
    await fake.close();
  }
});
