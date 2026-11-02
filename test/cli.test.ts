/**
 * `taa` entry-point behaviour.
 *
 * `serve` builds the control service, so without configuration it fails with
 * the missing variable instead of an honest-stub message. `sim` runs the
 * weekend simulation. The member and manager commands live in `test/cli/`
 * against the fake API; here the entry point only promises usage, routing and
 * exit codes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("taa serve reports missing configuration, not a stub", () => {
  const result = run(["serve"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /taa serve: .* is not set/);
  assert.equal(result.stdout, "");
});

test("taa sim writes the four weekend runs", () => {
  const out = mkdtempSync(join(tmpdir(), "taa-sim-cli-"));
  const result = run(["sim", "--out", out]);
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(out).sort(), [
    "all-limits.json",
    "budget-only.json",
    "no-limits.json",
    "off-hours-only.json",
  ]);
  assert.match(result.stdout, /all-limits: unattended_pause/);
});

test("help lists the member and manager commands", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0);
  for (const command of [
    "mcp",
    "status",
    "request",
    "requests",
    "decide",
    "block",
    "unblock",
    "audit",
    "doctor",
    "hints",
  ]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test("an unknown command prints usage and fails", () => {
  const result = run(["nonsense"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "nonsense"/);
  assert.match(result.stderr, /Usage: taa/);
});

test("a command without a credential fails as usage, never as a crash", () => {
  const result = run(["status"], { TAA_BASE_URL: "http://127.0.0.1:1" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TAA_MEMBER_KEY/);
});

test("an unknown role is a usage error on stderr only", () => {
  const result = run(["mcp", "--role", "owner"], {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --role/);
  assert.equal(result.stdout, "");
});
