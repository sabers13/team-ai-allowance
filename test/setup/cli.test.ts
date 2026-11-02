/**
 * `node src/setup/cli.ts`: bundle generation without a key on argv.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KEY, spec } from "./fixture.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "setup", "cli.ts");

function run(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function writeSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), "taa-setup-cli-"));
  const path = join(dir, "spec.json");
  const parsed = spec();
  writeFileSync(
    path,
    JSON.stringify({
      team: { ...parsed.team, security: parsed.team.security },
      member: parsed.member,
    }),
  );
  return path;
}

test("generates a bundle from TAA_MEMBER_KEY and prints the plan", () => {
  const specPath = writeSpec();
  const out = mkdtempSync(join(tmpdir(), "taa-setup-out-"));
  const result = run(["--spec", specPath, "--out", out], { TAA_MEMBER_KEY: KEY });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /managed\/claude-code\/managed-settings\.json/);
  assert.match(result.stdout, /deploy\/managed\/install\.sh/);
  assert.equal(result.stdout.includes(KEY), false);
  assert.equal(result.stderr.includes(KEY), false);
  assert.equal(statSync(join(out, "member/taa.env")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(out, "member/taa.env"), "utf8"), new RegExp(KEY));
});

test("reads the key from a file and refuses an unknown --key argument", () => {
  const specPath = writeSpec();
  const dir = mkdtempSync(join(tmpdir(), "taa-setup-key-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const out = mkdtempSync(join(tmpdir(), "taa-setup-out-"));

  const fromFile = run(["--spec", specPath, "--out", out], { TAA_MEMBER_KEY_FILE: keyFile });
  assert.equal(fromFile.status, 0, fromFile.stderr);

  const withArg = run(["--spec", specPath, "--out", out, "--key", KEY]);
  assert.equal(withArg.status, 2);
  assert.match(withArg.stderr, /unknown argument: --key/);
});

test("a missing key is a usage error and writes nothing", () => {
  const specPath = writeSpec();
  const out = mkdtempSync(join(tmpdir(), "taa-setup-out-"));
  const result = run(["--spec", specPath, "--out", out]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TAA_MEMBER_KEY/);
});

test("an invalid spec names the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "taa-setup-cli-"));
  const path = join(dir, "spec.json");
  writeFileSync(path, JSON.stringify({ team: {}, member: {} }));
  const result = run(["--spec", path, "--out", dir], { TAA_MEMBER_KEY: KEY });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /setup: team\./);
});
