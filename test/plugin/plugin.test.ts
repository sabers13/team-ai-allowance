import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { sessionStatePath } from "../../src/plugin/team-ai-allowance.ts";
import { type Harness, harness, jsonResponse, policyPayload } from "./helpers.ts";

const STATE_DIRS: string[] = [];

function freshStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "taa-plugin-"));
  STATE_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (STATE_DIRS.length > 0) {
    const dir = STATE_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function stateFile(h: Harness): string {
  return sessionStatePath(h.stateDir, "ses_test");
}

test("assistant cost accumulates once per message and fires 50% and 80% notices", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    routes: {
      "/api/me/session-policy": () => jsonResponse(policyPayload()),
    },
  });
  await h.assistant("ses_test", "msg_1", 0.2, false);
  assert.equal(h.controller.state("ses_test").costUsd, 0, "streaming message is not counted yet");

  await h.assistant("ses_test", "msg_1", 0.2);
  await h.assistant("ses_test", "msg_1", 0.25);
  assert.equal(h.controller.state("ses_test").costUsd, 0.25, "the same id replaces, never sums");

  await h.assistant("ses_test", "msg_2", 0.25);
  assert.equal(h.controller.state("ses_test").costUsd, 0.5);
  assert.equal(
    h.client.prompts.some((prompt) => prompt.text.includes("50% used")),
    true,
  );

  await h.assistant("ses_test", "msg_3", 0.3);
  assert.equal(h.controller.state("ses_test").costUsd, 0.8);
  assert.equal(
    h.client.prompts.some((prompt) => prompt.text.includes("80% used")),
    true,
  );
  assert.deepEqual(h.controller.state("ses_test").warnFired, [0.5, 0.8]);
});

test("the stop ratio blocks the next tool, aborts once and tells the member to request more", async () => {
  const events: unknown[] = [];
  const h = harness({
    stateDir: freshStateDir(),
    routes: {
      "/api/me/session-policy": () => jsonResponse(policyPayload()),
      "/api/me/session-events": (call) => {
        events.push(call.body);
        return jsonResponse({ ok: true }, 202);
      },
    },
  });
  await h.assistant("ses_test", "msg_1", 1);
  await h.controller.flush();

  assert.equal(h.client.aborts.length, 1);
  assert.equal(
    h.client.prompts.some((prompt) => prompt.text.startsWith("Session budget exhausted:")),
    true,
  );
  assert.equal(
    h.client.prompts.some((prompt) => prompt.text.includes("request_more_budget")),
    true,
  );

  await assert.rejects(
    () => h.before("ses_test", "bash", { command: "ls" }),
    /Session budget exhausted: USD 1\.00 of USD 1\.00 used/,
  );
  await h.controller.flush();
  assert.equal(h.client.aborts.length, 1, "abort happens once, not on every block");
  const posted = events.filter(
    (event): event is { kind: string; sessionId: string; detail: unknown } =>
      typeof event === "object" && event !== null && "kind" in event,
  );
  assert.equal(
    posted.some((event) => event.kind === "budget_stop"),
    true,
  );
  assert.equal(
    posted.some((event) => event.kind === "budget_warning"),
    true,
  );
  assert.equal(
    posted.every((event) => event.sessionId === "ses_test"),
    true,
  );
});

test("a human message clears an unattended pause and a new turn can work", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T09:00:00Z",
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await h.user("ses_test", "start here");
  await h.before("ses_test", "read", { file: "a" });

  h.clock.advance(29 * 60_000);
  await h.before("ses_test", "read", { file: "b" });
  assert.equal(h.client.aborts.length, 0);

  h.clock.advance(2 * 60_000);
  await assert.rejects(
    () => h.before("ses_test", "read", { file: "c" }),
    /Unattended session paused: 30 minutes without a human message/,
  );
  assert.equal(h.client.aborts.length, 1);

  await h.user("ses_test", "I am back");
  await h.before("ses_test", "read", { file: "d" });
  assert.equal(h.controller.state("ses_test").pause, null);
});

test("off-hours uses the short 10 minute and 15 step limits", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T23:00:00Z",
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await h.user("ses_test", "night work");
  h.clock.advance(9 * 60_000);
  await h.before("ses_test", "read", { file: "a" });
  h.clock.advance(2 * 60_000);
  await assert.rejects(
    () => h.before("ses_test", "read", { file: "b" }),
    /Unattended session paused: 10 minutes without a human message/,
  );

  const steps = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T23:00:00Z",
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await steps.user("ses_test", "night work");
  for (let index = 0; index < 15; index += 1) {
    await steps.before("ses_test", "read", { file: `f${index}` });
  }
  await assert.rejects(
    () => steps.before("ses_test", "read", { file: "sixteen" }),
    /15 steps without a human message/,
  );
});

test("the same tool and arguments five times pauses the loop and aborts", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T09:00:00Z",
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await h.user("ses_test", "try the test");
  for (let index = 0; index < 4; index += 1) {
    await h.before("ses_test", "bash", { command: "npm test" });
  }
  await assert.rejects(
    () => h.before("ses_test", "bash", { command: "npm test" }),
    /Loop paused: the same tool call repeated/,
  );
  assert.equal(h.client.aborts.length, 1);

  await h.user("ses_test", "try something else");
  await h.before("ses_test", "bash", { command: "npm test -- --watch=false" });
  assert.equal(h.controller.state("ses_test").pause, null);
});

test("the same tool error three times pauses the loop", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T09:00:00Z",
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await h.user("ses_test", "run it");
  for (let index = 0; index < 3; index += 1) {
    await h.before("ses_test", "bash", { command: `cmd-${index}` });
    await h.after("ses_test", "bash", "Error: cannot find module");
  }
  assert.equal(h.controller.state("ses_test").pause?.kind, "loop");
  assert.equal(h.controller.state("ses_test").pause?.reason, "error");
  assert.equal(h.client.aborts.length, 1);
  await assert.rejects(
    () => h.before("ses_test", "bash", { command: "anything" }),
    /Loop paused: the same error repeated/,
  );
});

test("state survives a restart: cost, warnings and a pause are not repeated", async () => {
  const dir = freshStateDir();
  const routes = { "/api/me/session-policy": () => jsonResponse(policyPayload()) };
  const first = harness({ stateDir: dir, routes });
  await first.assistant("ses_test", "msg_1", 0.5);
  assert.equal(first.controller.state("ses_test").warnFired.length, 1);
  for (let index = 0; index < 4; index += 1) {
    await first.before("ses_test", "bash", { command: "same" });
  }
  await assert.rejects(() => first.before("ses_test", "bash", { command: "same" }));

  const second = harness({ stateDir: dir, start: "2026-10-27T09:05:00Z", routes });
  assert.equal(second.controller.state("ses_test").costUsd, 0.5);
  assert.equal(second.controller.state("ses_test").pause?.kind, "loop");
  assert.deepEqual(second.controller.state("ses_test").warnFired, [0.5]);

  await assert.rejects(
    () => second.before("ses_test", "bash", { command: "other" }),
    /Loop paused/,
  );
  await second.assistant("ses_test", "msg_2", 0.1);
  assert.equal(
    second.client.prompts.filter((prompt) => prompt.text.includes("50% used")).length,
    0,
    "a restarted session does not repeat a warning",
  );
  assert.equal(second.controller.state("ses_test").costUsd, 0.6);
});

test("the state file stores no prompt, response or argument text", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    routes: { "/api/me/session-policy": () => jsonResponse(policyPayload()) },
  });
  await h.user("ses_test", "PROMPT_SECRET_7f3a");
  await h.before("ses_test", "bash", { command: "ARG_SECRET_91bc" });
  await h.after("ses_test", "bash", {
    output: "OUTPUT_SECRET_2d10 and Error: boom",
    metadata: { error: "META_SECRET_44ee" },
  });
  await h.assistant("ses_test", "msg_1", 0.01);

  const raw = readFileSync(stateFile(h), "utf8");
  for (const secret of [
    "PROMPT_SECRET_7f3a",
    "ARG_SECRET_91bc",
    "OUTPUT_SECRET_2d10",
    "META_SECRET_44ee",
  ]) {
    assert.equal(raw.includes(secret), false, `state must not contain ${secret}`);
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "costUsd",
    "createdAt",
    "errorCounts",
    "lastHumanAt",
    "lastPolicy",
    "lastPolicyFetchAt",
    "lastSoftCheckAt",
    "messageCosts",
    "messageOrder",
    "pause",
    "policyFallbackPosted",
    "sessionId",
    "softNoticeShown",
    "stepsSinceHuman",
    "stopFired",
    "toolCounts",
    "updatedAt",
    "version",
    "warnFired",
  ]);
});

test("the soft-limit notice is model-visible once, uses the team ratio and checks at most once a minute", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T09:00:00Z",
    routes: {
      "/api/me/session-policy": () => jsonResponse(policyPayload({ softLimit: { ratio: 0.7 } })),
      "/api/me": () =>
        jsonResponse({
          spendUsd: 16.6,
          effectiveBudgetUsd: 20,
          limits: { budgetUsd: 20, period: "weekly" },
          status: "soft",
        }),
      "/api/me/session-events": () => jsonResponse({ ok: true }, 202),
    },
  });

  await h.before("ses_test", "read", { file: "a" });
  await h.controller.flush();
  assert.equal(h.fetch.paths.filter((path) => path === "/api/me").length, 1);
  const notice = h.client.prompts.find((prompt) => prompt.text.startsWith("Allowance: "));
  assert.ok(notice);
  assert.equal(
    notice.text,
    "Allowance: 83% of today's budget used. If you need more for this task, call request_more_budget now, before it runs out.",
  );
  assert.equal(notice.noReply, true);

  h.clock.advance(30_000);
  await h.before("ses_test", "read", { file: "b" });
  await h.controller.flush();
  assert.equal(
    h.fetch.paths.filter((path) => path === "/api/me").length,
    1,
    "no second allowance call inside one minute",
  );

  h.clock.advance(61_000);
  await h.before("ses_test", "read", { file: "c" });
  await h.controller.flush();
  assert.equal(
    h.client.prompts.filter((prompt) => prompt.text.startsWith("Allowance: ")).length,
    1,
    "only one model-visible note per session",
  );
});

test("policy is cached, then falls back to the last known policy when the service is down", async () => {
  const dir = freshStateDir();
  let down = false;
  const routes = {
    "/api/me/session-policy": () => {
      if (down) return jsonResponse({ error: { code: "unavailable" } }, 503);
      return jsonResponse(
        policyPayload({ budget: { limitUsd: 0.2, spentUsd: 0, warnRatios: [0.5], stopRatio: 1 } }),
      );
    },
    "/api/me": () => jsonResponse({ error: { code: "unavailable" } }, 503),
    "/api/me/session-events": () => jsonResponse({ ok: true }, 202),
  };
  const h = harness({ stateDir: dir, start: "2026-10-27T09:00:00Z", routes });

  await h.before("ses_test", "read", { file: "a" });
  assert.equal(h.fetch.paths.filter((path) => path === "/api/me/session-policy").length, 1);
  await h.before("ses_test", "read", { file: "b" });
  assert.equal(
    h.fetch.paths.filter((path) => path === "/api/me/session-policy").length,
    1,
    "policy is cached inside its TTL",
  );

  down = true;
  h.clock.advance(61_000);
  await h.assistant("ses_test", "msg_1", 0.2);
  await h.controller.flush();
  await assert.rejects(
    () => h.before("ses_test", "read", { file: "c" }),
    /Session budget exhausted: USD 0\.20 of USD 0\.20 used/,
    "the last known budget still stops the session",
  );
  assert.equal(
    h.fetch.paths.includes("/api/me/session-events"),
    true,
    "the fallback is reported to the manager",
  );
});

test("a policy without a dedicated route still works through GET /api/me", async () => {
  const h = harness({
    stateDir: freshStateDir(),
    routes: {
      "/api/me": () =>
        jsonResponse({
          spendUsd: 0,
          effectiveBudgetUsd: 0.1,
          limits: { budgetUsd: 0.1 },
          status: "ok",
        }),
    },
  });
  await h.assistant("ses_test", "msg_1", 0.1);
  await assert.rejects(
    () => h.before("ses_test", "read", { file: "a" }),
    /Session budget exhausted: USD 0\.10 of USD 0\.10 used/,
  );
});

test("the event body carries ids, numbers and kinds only", async () => {
  const bodies: unknown[] = [];
  const h = harness({
    stateDir: freshStateDir(),
    start: "2026-10-27T09:00:00Z",
    routes: {
      "/api/me/session-policy": () => jsonResponse(policyPayload()),
      "/api/me/session-events": (call) => {
        bodies.push(call.body);
        return jsonResponse({ ok: true }, 202);
      },
    },
  });
  await h.user("ses_test", "SECRET_PROMPT_THAT_MUST_NOT_LEAVE");
  await h.assistant("ses_test", "msg_1", 0.5);
  await h.controller.flush();
  assert.ok(bodies.length > 0);
  const text = JSON.stringify(bodies);
  assert.equal(text.includes("SECRET_PROMPT_THAT_MUST_NOT_LEAVE"), false);
  for (const body of bodies) {
    assert.equal(typeof body, "object");
    assert.equal((body as { sessionId?: unknown }).sessionId, "ses_test");
  }
});
