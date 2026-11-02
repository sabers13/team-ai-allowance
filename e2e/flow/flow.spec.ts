/**
 * The scripted demo flow.
 *
 * One browser and one control service, a deterministic clock and the local
 * gateway mock. Every model call goes through the mock's HTTP routes with the
 * member's gateway key, exactly as a CLI would. Screenshots for each step are
 * written to `test-results/demo/` so a run leaves the tree clean; set
 * `TAA_DEMO_SHOT_DIR=results/demo` to regenerate the committed evidence.
 *
 * The nine steps:
 *   1. Lena works.
 *   2. Lena hits the soft limit (notice).
 *   3. Lena hits the hard limit (the gateway refuses with a readable message).
 *   4. Lena asks for USD 5 more through the MCP desk.
 *   5. Priya approves USD 3 until Friday.
 *   6. Lena continues.
 *   7. Omar asks for the flagship; the hint names a cheaper model; Priya denies.
 *   8. Jonas is blocked by the off-hours cap; Priya unblocks him.
 *   9. The audit log shows all of it, and `/usage` shows the period numbers.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, loadServerConfig } from "../../src/server/index.ts";
import { McpHarness } from "../../test/mcp/harness.ts";
import { expect, test } from "../fixtures.ts";
import { type FakeGateway, startFakeGateway } from "./fake-gateway.ts";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");
const SHOT_DIR = process.env.TAA_DEMO_SHOT_DIR ?? join("test-results", "demo");
const MANAGER_EMAIL = "priya@example.test";

class MutableClock {
  private at: Date;

  constructor(iso: string) {
    this.at = new Date(iso);
  }

  now(): Date {
    return new Date(this.at);
  }

  set(iso: string): void {
    this.at = new Date(iso);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

interface ModelCallResult {
  status: number;
  message: string | null;
}

interface StepEvidence {
  step: number;
  name: string;
  screenshot: string;
  observed: string;
}

function errorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

test("the nine-step demo flow", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOT_DIR, { recursive: true });

  const clock = new MutableClock("2026-11-02T09:00:00Z");
  const gateway: FakeGateway = await startFakeGateway({
    port: 0,
    now: () => clock.now(),
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const scratch = mkdtempSync(join(tmpdir(), "taa-flow-"));
  const hintsPath = join(scratch, "model-hints.json");
  writeFileSync(
    hintsPath,
    JSON.stringify({
      version: 1,
      hints: [
        {
          modelId: "mock-flagship",
          instead: ["mock-flash", "mock-cheap"],
          note: "Try the cheaper default model first; ask for the flagship only with a concrete reason.",
        },
      ],
    }),
  );

  const managerPassword = randomBytes(16).toString("base64url");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAA_PORT: String(port),
    TAA_PUBLIC_URL: base,
    TAA_DEV_SECRETS: "1",
    TAA_DB_PATH: ":memory:",
    TAA_GATEWAY_URL: gateway.url,
    LITELLM_MASTER_KEY: "sk-e2e-master",
    TAA_DEMO_SEED: "1",
    TAA_DEMO_MANAGER_PASSWORD: managerPassword,
    TAA_WATCH_INTERVAL_MS: "3600000",
    TAA_RECONCILE_INTERVAL_MS: "3600000",
    TAA_HINTS_FILE: hintsPath,
  };
  const config = loadServerConfig({ env, port });
  const server = await createControlServer({ config, env, clock });
  const steps: StepEvidence[] = [];

  const shot = async (name: string): Promise<string> => {
    const file = join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  async function callModel(key: string, model: string): Promise<ModelCallResult> {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
    });
    const body: unknown = await response.json();
    return { status: response.status, message: errorMessage(body) };
  }

  try {
    await server.start();
    const demo = server.demo;
    expect(demo, "the demo seed ran").not.toBeNull();
    if (demo === null) throw new Error("the demo seed did not run");
    const managerToken = demo.managerToken;
    expect(managerToken, "the demo issued a manager token").not.toBeNull();
    if (managerToken === null) throw new Error("no manager token");

    const members = new Map(demo.members.map((member) => [member.displayName, member]));
    const keys = new Map(demo.keys.map((key) => [key.displayName, key.secret]));
    const lena = members.get("Lena");
    const omar = members.get("Omar");
    const jonas = members.get("Jonas");
    const lenaKey = keys.get("Lena");
    const omarKey = keys.get("Omar");
    const jonasKey = keys.get("Jonas");
    if (lena === undefined || omar === undefined || jonas === undefined) {
      throw new Error("the demo seed is missing a member");
    }
    if (lenaKey === undefined || omarKey === undefined || jonasKey === undefined) {
      throw new Error("the demo seed is missing a member key");
    }

    async function api(method: string, path: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${managerToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed: unknown = text === "" ? null : JSON.parse(text);
      expect(response.status, `${method} ${path}`).toBeLessThan(400);
      return parsed;
    }

    async function mcp(role: "member" | "manager", env: NodeJS.ProcessEnv) {
      return McpHarness.start(CLI, role, { ...process.env, ...env });
    }

    // Sign in as the manager through the console form, as a person would.
    async function signIn(): Promise<void> {
      await page.goto(`${base}/login`);
      await page.getByLabel("E-mail").fill(MANAGER_EMAIL);
      await page.getByLabel("Password").fill(managerPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(`${base}/`);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn();

    // 1. Lena works.
    const first = await callModel(lenaKey, "mock-cheap");
    expect(first.status, first.message ?? "").toBe(200);
    steps.push({
      step: 1,
      name: "Lena works",
      screenshot: await shot("step-01-lena-works"),
      observed: "mock-cheap answered 200 for Lena's key",
    });

    // The demo budget is narrowed so a handful of calls crosses every line.
    await api("PATCH", `/api/team/members/${lena.id}/limits`, { budgetUsd: 0.7 });

    // 2. Lena hits the soft limit.
    const second = await callModel(lenaKey, "mock-cheap");
    expect(second.status, second.message ?? "").toBe(200);
    const softTick = await server.watcher.tick();
    expect(softTick.errors, softTick.errors.join("; ")).toEqual([]);
    await page.goto(`${base}/members/${lena.id}`);
    await expect(page.getByText("Soft limit").first()).toBeVisible();
    steps.push({
      step: 2,
      name: "Lena hits the soft limit",
      screenshot: await shot("step-02-lena-soft"),
      observed: `spend USD 0.60 of USD 0.70; watcher recorded ${softTick.newRows} spend row(s)`,
    });

    // 3. The gateway refuses the next call with the budget message.
    const third = await callModel(lenaKey, "mock-cheap");
    expect(third.status).toBe(422);
    expect(third.message ?? "").toMatch(/Budget has been exceeded!/);
    await page.goto(`${base}/`);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    steps.push({
      step: 3,
      name: "Lena hits the hard limit",
      screenshot: await shot("step-03-lena-hard"),
      observed: third.message ?? "",
    });

    // 4. Lena asks for USD 5 through the MCP desk.
    const memberDesk = await mcp("member", {
      TAA_BASE_URL: base,
      TAA_MEMBER_KEY: lenaKey,
      TAA_HINTS_FILE: hintsPath,
    });
    let budgetRequestId = "";
    try {
      const response = await memberDesk.callTool("request_more_budget", {
        amountUsd: 5,
        reason: "One long refactor needs more room this week.",
      });
      const result = response.result as
        | { structuredContent?: { id?: string }; content?: Array<{ text?: string }> }
        | undefined;
      budgetRequestId = result?.structuredContent?.id ?? "";
      expect(budgetRequestId, JSON.stringify(response)).not.toBe("");
    } finally {
      await memberDesk.stop();
    }
    await page.goto(`${base}/requests/${budgetRequestId}`);
    await expect(page.getByText("USD 5.00").first()).toBeVisible();
    steps.push({
      step: 4,
      name: "Lena asks for USD 5 through MCP",
      screenshot: await shot("step-04-lena-request"),
      observed: `request ${budgetRequestId} pending`,
    });

    // 5. Priya approves USD 3 until Friday (2026-11-06).
    await page.getByText("Approve a smaller amount or a shorter window").click();
    await page.locator(`#partly-amount-${budgetRequestId}`).fill("3");
    await page.locator(`#partly-until-${budgetRequestId}`).fill("2026-11-06");
    await page
      .locator(`#partly-note-${budgetRequestId}`)
      .fill("Enough for the refactor. Back to the weekly budget on Friday.");
    await page.getByRole("button", { name: "Approve partly" }).click();
    await expect(page.getByText("Partly approved").first()).toBeVisible();
    steps.push({
      step: 5,
      name: "Priya approves USD 3 until Friday",
      screenshot: await shot("step-05-priya-partly"),
      observed: `grant of USD 3.00 until 2026-11-06 on ${budgetRequestId}`,
    });

    // 6. Lena continues on the same key.
    const afterGrant = await callModel(lenaKey, "mock-cheap");
    expect(afterGrant.status, afterGrant.message ?? "").toBe(200);
    const grantTick = await server.watcher.tick();
    expect(grantTick.errors, grantTick.errors.join("; ")).toEqual([]);
    await page.goto(`${base}/`);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    steps.push({
      step: 6,
      name: "Lena continues",
      screenshot: await shot("step-06-lena-continues"),
      observed: "mock-cheap answered 200 after the partial approval",
    });

    // 7. Omar asks for the flagship, sees the hint, and is denied with a note.
    const omarDesk = await mcp("member", {
      TAA_BASE_URL: base,
      TAA_MEMBER_KEY: omarKey,
      TAA_HINTS_FILE: hintsPath,
    });
    let modelRequestId = "";
    try {
      const response = await omarDesk.callTool("request_model", {
        modelId: "mock-flagship",
        hours: 4,
        reason: "One hard parsing task needs the flagship this afternoon.",
      });
      const result = response.result as
        | { structuredContent?: { id?: string }; content?: Array<{ text?: string }> }
        | undefined;
      const text = result?.content?.[0]?.text ?? "";
      expect(text).toContain("cheaper option is mock-flash");
      modelRequestId = result?.structuredContent?.id ?? "";
      expect(modelRequestId).not.toBe("");
    } finally {
      await omarDesk.stop();
    }
    await page.goto(`${base}/requests/${modelRequestId}`);
    await page
      .locator(`#deny-note-${modelRequestId}`)
      .fill("Use mock-flash for this task; it is enough. Ask again if it fails.");
    await page.getByRole("button", { name: "Deny request" }).click();
    await expect(page.getByText("Denied").first()).toBeVisible();
    steps.push({
      step: 7,
      name: "Omar's flagship request is denied with a note",
      screenshot: await shot("step-07-omar-denied"),
      observed: `hint named mock-flash; ${modelRequestId} denied with a note`,
    });

    // 8. Jonas keeps working after hours; the watcher blocks, Priya unblocks.
    clock.set("2026-11-02T22:00:00Z");
    const nightOne = await callModel(jonasKey, "mock-cheap");
    const nightTwo = await callModel(jonasKey, "mock-cheap");
    expect(nightOne.status, nightOne.message ?? "").toBe(200);
    expect(nightTwo.status, nightTwo.message ?? "").toBe(200);
    const nightTick = await server.watcher.tick();
    expect(nightTick.blocked, nightTick.errors.join("; ")).toContain(jonas.id);
    // The clock jumped 13 hours; the 12-hour console session has expired.
    await signIn();
    await page.goto(`${base}/members/${jonas.id}`);
    await expect(page.getByText("Blocked").first()).toBeVisible();
    await expect(page.getByText(/off.?hours/i).first()).toBeVisible();
    steps.push({
      step: 8,
      name: "Jonas is blocked by the off-hours cap",
      screenshot: await shot("step-08-jonas-offhours"),
      observed: `watcher blocked ${jonas.id}: USD 0.60 of USD 0.50 off-hours`,
    });

    await page.getByRole("button", { name: "Unblock key" }).click();
    await expect(page.getByText("Active").first()).toBeVisible();
    const afterUnblock = await callModel(jonasKey, "mock-cheap");
    expect(afterUnblock.status, afterUnblock.message ?? "").toBe(200);
    const releaseTick = await server.watcher.tick();
    expect(releaseTick.blocked).not.toContain(jonas.id);
    await page.goto(`${base}/members/${jonas.id}`);
    steps.push({
      step: 8.5,
      name: "Priya unblocks Jonas",
      screenshot: await shot("step-08b-jonas-unblocked"),
      observed: "manager unblock held for the off-hours stretch; the key works again",
    });

    // 9. The audit log shows all of it.
    await page.goto(`${base}/audit`);
    await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
    const auditText = await page.locator("main").textContent();
    for (const action of [
      "request.created",
      "request.decided",
      "grant.issued",
      "limits.updated",
      "watcher.off_hours_block",
      "member.unblocked",
    ]) {
      expect(auditText, action).toContain(action);
    }
    steps.push({
      step: 9,
      name: "The audit log shows all of it",
      screenshot: await shot("step-09-audit"),
      observed: "request, decision, grant, limit, watcher block and unblock all present",
    });

    // Usage page evidence: table, chart and CSV export.
    await page.goto(`${base}/usage?period=30`);
    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
    const usageText = await page.locator("main").textContent();
    expect(usageText).toContain("Lena");
    expect(usageText).toContain("Jonas");
    expect(usageText).toContain("Daily cost");
    const usageShot = await shot("step-10-usage");
    const csv = await page.request.get(`${base}/usage.csv?period=30`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain("member_id");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${base}/usage?period=30`);
    await shot("step-10-usage-360");
    await page.setViewportSize({ width: 1280, height: 900 });
    steps.push({
      step: 10,
      name: "Usage page: table, chart and CSV",
      screenshot: usageShot,
      observed: "period table, stacked daily chart, /usage.csv download",
    });

    writeFileSync(
      join(SHOT_DIR, "flow.json"),
      `${JSON.stringify(
        {
          generatedBy: "e2e/flow/flow.spec.ts",
          clock: clock.now().toISOString(),
          team: demo.teamId,
          steps,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await server.stop();
    await gateway.close();
  }
});
