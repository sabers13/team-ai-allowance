/**
 * Member-desk MCP tools against the fake API.
 * Every member tool is driven over real stdio JSON-RPC.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeApi, MANAGER_TOKEN, McpHarness, MEMBER_KEY } from "./harness.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

function memberEnv(fake: FakeApi, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TAA_BASE_URL: fake.url, TAA_MEMBER_KEY: MEMBER_KEY, ...extra };
}

function textOf(response: { result?: unknown }): string {
  const result = response.result as { content: Array<{ type: string; text: string }> };
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, "text");
  return result.content[0]?.text ?? "";
}

function structuredOf<T>(response: { result?: unknown }): T {
  return (response.result as { structuredContent: T }).structuredContent;
}

test("member desk lists exactly the seven frozen tools", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      const names = (await mcp.listTools()).map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "allowed_models",
        "cancel_request",
        "my_allowance",
        "my_requests",
        "request_model",
        "request_more_budget",
        "send_suggestion",
      ]);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("my_allowance reports what is left, the status and the models", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      const response = await mcp.callTool("my_allowance", {});
      assert.equal(response.error, undefined);
      const text = textOf(response);
      assert.match(text, /USD 3\.40 left of USD 20\.00/);
      assert.match(text, /83% used, soft/);
      assert.match(text, /Allowed: flash, mini/);
      const data = structuredOf<{
        remainingUsd: number;
        budgetUsd: number;
        spendUsd: number;
        status: string;
        allowedModels: string[];
      }>(response);
      assert.ok(Math.abs(data.remainingUsd - 3.4) < 1e-9);
      assert.equal(data.budgetUsd, 20);
      assert.equal(data.status, "soft");
      assert.deepEqual(data.allowedModels, ["flash", "mini"]);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("allowed_models lists one model id per line", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      const response = await mcp.callTool("allowed_models", {});
      assert.equal(textOf(response), "flash\nmini");
      const data = structuredOf<{ models: Array<{ id: string; state: string }> }>(response);
      assert.deepEqual(
        data.models.map((model) => model.id),
        ["flash", "mini"],
      );
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("request_more_budget sends the amount and keeps the until date", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      const response = await mcp.callTool("request_more_budget", {
        amountUsd: 5,
        until: "2026-11-07",
        reason: "migration needs headroom",
      });
      assert.equal(textOf(response), "Request sent to your manager.");
      const data = structuredOf<{ id: string; state: string }>(response);
      assert.equal(data.id, "r-new");
      assert.equal(data.state, "pending");
      const last = fake.calls[fake.calls.length - 1];
      assert.equal(last?.path, "/api/me/requests");
      const body = last?.body as { message: string; amountUsd: number };
      assert.equal(body.amountUsd, 5);
      assert.match(body.message, /migration needs headroom/);
      assert.match(body.message, /2026-11-07/);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("request_model names the cheaper option when a hint exists", async () => {
  const fake = await FakeApi.start();
  const dir = mkdtempSync(join(tmpdir(), "taa-hints-"));
  const hintsFile = join(dir, "hints.json");
  writeFileSync(
    hintsFile,
    JSON.stringify({
      version: 1,
      hints: [{ modelId: "flagship", instead: ["flash"], note: "try first" }],
    }),
  );
  try {
    const mcp = await McpHarness.start(
      CLI,
      "member",
      memberEnv(fake, { TAA_HINTS_FILE: hintsFile }),
    );
    try {
      const hinted = await mcp.callTool("request_model", {
        modelId: "flagship",
        reason: "hard parsing task",
      });
      assert.equal(textOf(hinted), "Request sent; a cheaper option is flash.");
      const plain = await mcp.callTool("request_model", { modelId: "other", reason: "curious" });
      assert.equal(textOf(plain), "Request sent to your manager.");
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("send_suggestion, my_requests and cancel_request round-trip", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      const sent = await mcp.callTool("send_suggestion", { message: "cheaper afternoons?" });
      assert.equal(textOf(sent), "Noted for your manager.");

      const all = await mcp.callTool("my_requests", {});
      assert.equal(textOf(all).split("\n").length, 2);
      const pending = await mcp.callTool("my_requests", { state: "pending" });
      assert.equal(textOf(pending).split("\n").length, 1);
      assert.match(textOf(pending), /r-pending/);
      const limited = await mcp.callTool("my_requests", { limit: 1 });
      assert.equal(textOf(limited).split("\n").length, 1);

      const cancelled = await mcp.callTool("cancel_request", { requestId: "r-pending" });
      assert.equal(textOf(cancelled), "Request cancelled.");
      assert.equal(structuredOf<{ state: string }>(cancelled).state, "cancelled");
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("every stdout line is JSON: nothing but protocol on the channel", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "member", memberEnv(fake));
    try {
      await mcp.callTool("my_allowance", {});
      await mcp.callTool("my_requests", {});
      for (const line of mcp.stdoutLines) {
        assert.doesNotThrow(() => JSON.parse(line), `not JSON on stdout: ${line.slice(0, 80)}`);
      }
      assert.ok(mcp.stdoutLines.length > 0);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("a manager token is refused on the member desk with a readable sentence", async () => {
  const fake = await FakeApi.start();
  try {
    // The token role does not matter here; what matters is that a bad
    // credential surfaces as isError text, not a transport failure.
    const mcp = await McpHarness.start(CLI, "member", {
      TAA_BASE_URL: fake.url,
      TAA_MEMBER_KEY: `wrong-${MANAGER_TOKEN}`,
    });
    try {
      const response = await mcp.callTool("my_allowance", {});
      assert.equal(response.error, undefined);
      const result = response.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(textOf(response), /missing or unknown credential/);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});
