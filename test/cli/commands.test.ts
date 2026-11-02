/**
 * `taa` member and manager commands against the fake API.
 * Exit codes: 0 ok, 1 refused, 2 usage,
 * 3 unreachable.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeApi, MANAGER_TOKEN, MEMBER_KEY } from "../mcp/harness.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the real CLI without blocking the event loop: the fake API lives in
 * this process, so a blocking `spawnSync` would starve it and every call
 * would time out.
 */
function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

function memberEnv(fake: FakeApi, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TAA_BASE_URL: fake.url, TAA_MEMBER_KEY: MEMBER_KEY, ...extra };
}

function managerEnv(fake: FakeApi): NodeJS.ProcessEnv {
  return { TAA_BASE_URL: fake.url, TAA_MANAGER_TOKEN: MANAGER_TOKEN };
}

test("status prints the allowance paragraph", async () => {
  const fake = await FakeApi.start();
  try {
    const result = await run(["status"], memberEnv(fake));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /USD 3\.40 left of USD 20\.00 this period/);
    assert.match(result.stdout, /83% used, soft/);
  } finally {
    await fake.close();
  }
});

test("status --json prints the structured allowance", async () => {
  const fake = await FakeApi.start();
  try {
    const result = await run(["status", "--json"], memberEnv(fake));
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout) as { remainingUsd: number; status: string };
    assert.ok(Math.abs(data.remainingUsd - 3.4) < 1e-9);
    assert.equal(data.status, "soft");
  } finally {
    await fake.close();
  }
});

test("request more-budget, model and suggestion", async () => {
  const fake = await FakeApi.start();
  try {
    const budget = await run(
      ["request", "more-budget", "--amount", "5", "--until", "2026-11-07", "--reason", "migration"],
      memberEnv(fake),
    );
    assert.equal(budget.status, 0);
    assert.match(budget.stdout, /Request sent to your manager/);

    const model = await run(
      ["request", "model", "flagship", "--hours", "2", "--reason", "hard parsing task"],
      memberEnv(fake),
    );
    assert.equal(model.status, 0);

    const suggestion = await run(
      ["request", "suggestion", "--reason", "cheaper afternoons?"],
      memberEnv(fake),
    );
    assert.equal(suggestion.status, 0);
    assert.match(suggestion.stdout, /Noted for your manager/);

    const posted = fake.calls.filter((call) => call.path === "/api/me/requests");
    assert.equal(posted.length, 3);
  } finally {
    await fake.close();
  }
});

test("request validates its arguments", async () => {
  const fake = await FakeApi.start();
  try {
    assert.equal(
      (await run(["request", "more-budget", "--amount", "5"], memberEnv(fake))).status,
      2,
    );
    assert.equal(
      (await run(["request", "more-budget", "--amount", "-2", "--reason", "x"], memberEnv(fake)))
        .status,
      2,
    );
    assert.equal((await run(["request", "nonsense"], memberEnv(fake))).status, 2);
  } finally {
    await fake.close();
  }
});

test("requests lists mine, filters pending, and reads the team inbox", async () => {
  const fake = await FakeApi.start();
  try {
    const all = await run(["requests"], memberEnv(fake));
    assert.equal(all.status, 0);
    assert.equal(all.stdout.trim().split("\n").length, 2);

    const pending = await run(["requests", "--pending"], memberEnv(fake));
    assert.equal(pending.status, 0);
    assert.match(pending.stdout, /r-pending/);
    assert.doesNotMatch(pending.stdout, /r-done/);

    const team = await run(["requests", "--team", "--pending", "--json"], managerEnv(fake));
    assert.equal(team.status, 0);
    const data = JSON.parse(team.stdout) as { requests: Array<{ id: string }> };
    assert.deepEqual(
      data.requests.map((request) => request.id),
      ["r-pending"],
    );

    const refused = await run(["requests", "--team"], memberEnv(fake));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /TAA_MANAGER_TOKEN/);

    const wrongRole = await run(["decide", "r-pending", "approve", "--usd", "3", "--note", "ok"], {
      TAA_BASE_URL: fake.url,
      TAA_MANAGER_TOKEN: MEMBER_KEY,
    });
    assert.equal(wrongRole.status, 1);
    assert.match(wrongRole.stderr, /member key cannot call a manager route/);
  } finally {
    await fake.close();
  }
});

test("decide approves partly and denies; denial needs a note", async () => {
  const fake = await FakeApi.start();
  try {
    const approved = await run(
      ["decide", "r-pending", "approve", "--usd", "3", "--note", "ok"],
      managerEnv(fake),
    );
    assert.equal(approved.status, 0);
    assert.match(approved.stdout, /Approved USD 3\.00/);

    const denied = await run(
      ["decide", "r-pending", "deny", "--note", "out of budget"],
      managerEnv(fake),
    );
    assert.equal(denied.status, 0);
    assert.match(denied.stdout, /Denied/);

    assert.equal((await run(["decide", "r-pending", "deny"], managerEnv(fake))).status, 2);
    assert.equal(
      (await run(["decide", "r-pending", "maybe", "--note", "x"], managerEnv(fake))).status,
      2,
    );
  } finally {
    await fake.close();
  }
});

test("block and unblock toggle a member; block needs a reason", async () => {
  const fake = await FakeApi.start();
  try {
    const blocked = await run(["block", "m-omar", "--note", "off-hours spend"], managerEnv(fake));
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /now blocked/);

    const unblocked = await run(["unblock", "m-omar"], managerEnv(fake));
    assert.equal(unblocked.status, 0);
    assert.match(unblocked.stdout, /now unblocked/);

    assert.equal((await run(["block", "m-omar"], managerEnv(fake))).status, 2);
  } finally {
    await fake.close();
  }
});

test("audit prints events and exports JSON", async () => {
  const fake = await FakeApi.start();
  const dir = mkdtempSync(join(tmpdir(), "taa-audit-"));
  try {
    const listed = await run(["audit"], managerEnv(fake));
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /request\.created/);

    const outFile = join(dir, "audit.json");
    const exported = await run(["audit", "--export", outFile], managerEnv(fake));
    assert.equal(exported.status, 0);
    const events = JSON.parse(readFileSync(outFile, "utf8")) as unknown[];
    assert.equal(events.length, 1);
  } finally {
    await fake.close();
  }
});

test("hints import stores the file with owner-only permissions", async () => {
  const fake = await FakeApi.start();
  const dir = mkdtempSync(join(tmpdir(), "taa-hints-"));
  const source = join(dir, "source.json");
  const dest = join(dir, "stored", "model-hints.json");
  writeFileSync(
    source,
    JSON.stringify({ version: 1, hints: [{ modelId: "flagship", instead: ["flash"] }] }),
  );
  try {
    const result = await run(
      ["hints", "import", source],
      memberEnv(fake, { TAA_HINTS_FILE: dest }),
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /imported 1 hint/);
    assert.equal(statSync(dest).mode & 0o777, 0o600);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.equal(
      (await run(["hints", "import", bad], memberEnv(fake, { TAA_HINTS_FILE: dest }))).status,
      2,
    );
  } finally {
    await fake.close();
  }
});

test("a wrong credential is exit 1, a dead service is exit 3", async () => {
  const fake = await FakeApi.start();
  try {
    const refused = await run(["status"], { TAA_BASE_URL: fake.url, TAA_MEMBER_KEY: "wrong-key" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /missing or unknown credential/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /wrong-key/);
  } finally {
    await fake.close();
  }
  const dead = await run(["status"], {
    TAA_BASE_URL: "http://127.0.0.1:1",
    TAA_MEMBER_KEY: MEMBER_KEY,
  });
  assert.equal(dead.status, 3);
  assert.match(dead.stderr, /cannot reach/i);
});
