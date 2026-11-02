/**
 * Manager-desk MCP tools against the fake API.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FakeApi, MANAGER_TOKEN, McpHarness, MEMBER_KEY } from "./harness.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

function managerEnv(fake: FakeApi): NodeJS.ProcessEnv {
  return { TAA_BASE_URL: fake.url, TAA_MANAGER_TOKEN: MANAGER_TOKEN };
}

function textOf(response: { result?: unknown }): string {
  const result = response.result as { content: Array<{ text: string }> };
  return result.content[0]?.text ?? "";
}

function structuredOf<T>(response: { result?: unknown }): T {
  return (response.result as { structuredContent: T }).structuredContent;
}

async function desk(fake: FakeApi): Promise<McpHarness> {
  return McpHarness.start(CLI, "manager", managerEnv(fake));
}

test("manager desk lists exactly the seven frozen tools", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const names = (await mcp.listTools()).map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "decide_request",
        "list_requests",
        "member_usage",
        "set_member_limit",
        "set_member_models",
        "team_overview",
        "team_usage",
      ]);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("team_overview totals spend, budget, blocked and pending", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const response = await mcp.callTool("team_overview", {});
      assert.equal(response.error, undefined);
      assert.equal(
        textOf(response),
        "Team Platform: USD 37.60 spent of USD 100.00 this month. 1 blocked, 1 pending.",
      );
      const data = structuredOf<{
        spendUsd: number;
        budgetUsd: number;
        pendingRequests: unknown[];
      }>(response);
      assert.ok(Math.abs(data.spendUsd - 37.6) < 1e-9);
      assert.equal(data.budgetUsd, 100);
      assert.equal(data.pendingRequests.length, 1);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("team_usage totals the period, ranks models and labels the inferred CLI", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const response = await mcp.callTool("team_usage", { period: "30d" });
      assert.equal(response.error, undefined);
      assert.match(textOf(response), /Team Platform: 2 requests, USD 16\.60/);
      assert.match(textOf(response), /Top: flash USD 12\.10/);
      assert.match(textOf(response), /CLI inferred:/);
      const data = structuredOf<{
        totals: { requests: number; costUsd: number };
        members: Array<{ memberId: string; cliInferred: boolean }>;
        byModel: Array<{ modelId: string }>;
      }>(response);
      assert.deepEqual(data.totals, {
        requests: 2,
        inputTokens: 1800,
        outputTokens: 300,
        costUsd: 16.6,
      });
      assert.equal(data.members.length, 2);
      assert.equal(data.members[0]?.cliInferred, true);
      assert.deepEqual(
        data.byModel.map((row) => row.modelId),
        ["flash", "mini"],
      );
      const custom = await mcp.callTool("team_usage", { period: "custom" });
      const result = custom.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(textOf(custom), /For a custom period/);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("list_requests filters by state and member", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const all = await mcp.callTool("list_requests", {});
      assert.equal(textOf(all).split("\n").length, 2);
      const pending = await mcp.callTool("list_requests", { state: "pending" });
      assert.match(textOf(pending), /r-pending/);
      assert.doesNotMatch(textOf(pending), /r-done/);
      const structured = structuredOf<{ requests: Array<{ id: string }> }>(pending);
      assert.deepEqual(
        structured.requests.map((request) => request.id),
        ["r-pending"],
      );
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("decide_request approves, partly approves and denies with words", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const approved = await mcp.callTool("decide_request", {
        requestId: "r-pending",
        outcome: "approved",
        amountUsd: 10,
        until: "2026-11-07",
      });
      assert.equal(textOf(approved), "Approved USD 10.00 until 2026-11-07.");
      assert.equal(
        structuredOf<{ decision: { outcome: string } }>(approved).decision.outcome,
        "approved",
      );

      const partly = await mcp.callTool("decide_request", {
        requestId: "r-pending",
        outcome: "partly_approved",
        amountUsd: 3,
        note: "start here",
      });
      assert.equal(textOf(partly), "Partly approved USD 3.00. Note: start here");

      const denied = await mcp.callTool("decide_request", {
        requestId: "r-pending",
        outcome: "denied",
        note: "out of budget",
      });
      assert.equal(textOf(denied), "Denied. out of budget");

      const badDate = await mcp.callTool("decide_request", {
        requestId: "r-pending",
        outcome: "approved",
        until: "not-a-date",
      });
      const result = badDate.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(textOf(badDate), /not a date/);
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("set_member_limit and set_member_models confirm briefly", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const limit = await mcp.callTool("set_member_limit", { memberId: "m-lena", budgetUsd: 25 });
      assert.equal(textOf(limit), "Limit updated.");
      const last = fake.calls[fake.calls.length - 1];
      assert.equal(last?.path, "/api/team/members/m-lena/limits");

      const models = await mcp.callTool("set_member_models", {
        memberId: "m-lena",
        modelIds: ["flash"],
      });
      assert.equal(textOf(models), "Models updated.");
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("member_usage totals spend and ranks models", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await desk(fake);
    try {
      const response = await mcp.callTool("member_usage", { memberId: "m-lena", days: 30 });
      assert.match(textOf(response), /Lena spent USD 16\.60 in the last 30 days/);
      assert.match(textOf(response), /Top: flash USD 12\.10, mini USD 4\.50/);
      const data = structuredOf<{
        spendUsd: number;
        byModel: Array<{ modelId: string; spendUsd: number }>;
      }>(response);
      assert.ok(Math.abs(data.spendUsd - 16.6) < 1e-9);
      assert.deepEqual(
        data.byModel.map((entry) => entry.modelId),
        ["flash", "mini"],
      );
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});

test("a member key is refused on the manager desk", async () => {
  const fake = await FakeApi.start();
  try {
    const mcp = await McpHarness.start(CLI, "manager", {
      TAA_BASE_URL: fake.url,
      TAA_MANAGER_TOKEN: MEMBER_KEY,
    });
    try {
      const response = await mcp.callTool("team_overview", {});
      assert.equal(response.error, undefined);
      const result = response.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.equal(textOf(response), "A member key cannot call a manager route.");
    } finally {
      await mcp.stop();
    }
  } finally {
    await fake.close();
  }
});
