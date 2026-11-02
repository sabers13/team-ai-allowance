/**
 * Error paths for the MCP desks: a dead service, a refusal with a
 * code, malformed arguments, an unknown tool and bad startup config.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeApi, McpHarness, MEMBER_KEY } from "./harness.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

function textOf(response: { result?: unknown }): string {
  const result = response.result as { content: Array<{ text: string }> };
  return result.content[0]?.text ?? "";
}

/** A base URL whose port is closed: connecting fails fast. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return url;
}

test("a dead service is a readable isError, not a crash", async () => {
  const url = await closedUrl();
  const mcp = await McpHarness.start(CLI, "member", {
    TAA_BASE_URL: url,
    TAA_MEMBER_KEY: MEMBER_KEY,
  });
  try {
    const response = await mcp.callTool("my_allowance", {});
    assert.equal(response.error, undefined);
    const result = response.result as { isError?: boolean };
    assert.equal(result.isError, true);
    assert.equal(textOf(response), "Cannot reach the control service. Try again in a minute.");
    const code = await mcp.stop();
    assert.equal(code, 0);
  } catch (error) {
    await mcp.stop();
    throw error;
  }
});

test("a service refusal keeps its sentence", async () => {
  const fake = await FakeApi.start();
  fake.failures.set("GET /api/me", {
    status: 422,
    code: "over_limit",
    message: "weekly budget already used",
  });
  try {
    const mcp = await McpHarness.start(CLI, "member", {
      TAA_BASE_URL: fake.url,
      TAA_MEMBER_KEY: MEMBER_KEY,
    });
    try {
      const response = await mcp.callTool("my_allowance", {});
      const result = response.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.equal(textOf(response), "weekly budget already used");
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("an invalid amount never reaches the API: a readable isError instead", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", {
      TAA_BASE_URL: fake.url,
      TAA_MEMBER_KEY: MEMBER_KEY,
    });
    try {
      const response = await mcp.callTool("request_more_budget", { amountUsd: -5, reason: "x" });
      assert.equal(response.error, undefined);
      const result = response.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(textOf(response), /expected number to be >0/);
      assert.equal(
        fake.calls.some((call) => call.method === "POST" && call.path === "/api/me/requests"),
        false,
      );
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("an unknown tool is a protocol error", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", {
      TAA_BASE_URL: fake.url,
      TAA_MEMBER_KEY: MEMBER_KEY,
    });
    try {
      const response = await mcp.callTool("no_such_tool", {});
      assert.notEqual(response.error, undefined);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("a group-readable secret file is refused at startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "taa-key-"));
  const file = join(dir, "key.txt");
  writeFileSync(file, "some-key-material", { mode: 0o644 });
  const result = spawnSync(process.execPath, [CLI, "mcp", "--role", "member"], {
    env: { TAA_BASE_URL: "http://127.0.0.1:1", TAA_KEY_FILE: file },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mode 0600/);
});

test("a missing credential exits 2 with a hint, and writes nothing to stdout", () => {
  const result = spawnSync(process.execPath, [CLI, "mcp", "--role", "member"], {
    env: { TAA_BASE_URL: "http://127.0.0.1:1" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TAA_MEMBER_KEY/);
  assert.equal(result.stdout, "");
});
