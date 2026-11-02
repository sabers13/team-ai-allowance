import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  DEFAULT_SESSION_POLICY,
  isHumanMessage,
  isWorkingTime,
  parseSessionPolicy,
  policyFromAllowance,
  softLimitMessage,
  toolErrorSignature,
  toolSignature,
} from "../../src/plugin/team-ai-allowance.ts";

const HOURS = DEFAULT_SESSION_POLICY.unattended.workingHours;

test("working hours follow the policy zone, weekdays and holidays", () => {
  // Tuesday 10:00 in Berlin (CET after the DST change).
  assert.equal(isWorkingTime(HOURS, Date.parse("2026-10-27T09:00:00Z")), true);
  // Saturday.
  assert.equal(isWorkingTime(HOURS, Date.parse("2026-10-31T09:00:00Z")), false);
  // Before the 07:00 start.
  assert.equal(isWorkingTime(HOURS, Date.parse("2026-10-27T04:59:00Z")), false);
  // A holiday wins over a working weekday.
  assert.equal(
    isWorkingTime({ ...HOURS, holidays: ["2026-10-27"] }, Date.parse("2026-10-27T09:00:00Z")),
    false,
  );
});

test("a partial policy falls back per field and survives a bad time zone", () => {
  const policy = parseSessionPolicy({
    budget: { limitUsd: 3 },
    unattended: { workingHours: { timeZone: "Not/AZone" } },
    loop: { sameError: 4 },
  });
  assert.equal(policy.budget.limitUsd, 3);
  assert.equal(policy.budget.stopRatio, 1);
  assert.equal(policy.budget.warnRatios.length, 2);
  assert.equal(policy.unattended.workingHours.timeZone, "Europe/Berlin");
  assert.equal(policy.loop.sameError, 4);
  assert.equal(policy.loop.sameToolArgs, 5);
});

test("the allowance fallback carries the budget but never invents one", () => {
  const policy = policyFromAllowance({
    spendUsd: 1.5,
    effectiveBudgetUsd: 6,
    limits: { budgetUsd: 5 },
  });
  assert.equal(policy.budget.limitUsd, 6);
  assert.equal(policy.budget.spentUsd, 1.5);
  assert.equal(policy.softLimitRatio, 0.8);

  const unknown = policyFromAllowance({ status: "ok" });
  assert.equal(unknown.budget.limitUsd, Number.POSITIVE_INFINITY);
});

test("argument hashes ignore key order and hide the argument text", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  const first = toolSignature("bash", { command: "secret", cwd: "/tmp" });
  const second = toolSignature("bash", { cwd: "/tmp", command: "secret" });
  assert.equal(first, second);
  assert.equal(first.includes("secret"), false);
  assert.notEqual(first, toolSignature("bash", { command: "other", cwd: "/tmp" }));
});

test("error signatures are stable for numbers and ids and ignore clean output", () => {
  assert.equal(toolErrorSignature({ output: "all good" }), null);
  const one = toolErrorSignature({ output: "Error: request 123 failed after 4 tries" });
  const two = toolErrorSignature({ output: "Error: request 987 failed after 9 tries" });
  assert.equal(one, two);
  assert.notEqual(one, toolErrorSignature({ output: "Error: a different failure" }));
  assert.notEqual(toolErrorSignature({ output: "Error: boom", metadata: { error: "x" } }), null);
});

test("synthetic messages do not count as a human turn", () => {
  assert.equal(isHumanMessage({ role: "user" }, [{ type: "text", text: "hi" }]), true);
  assert.equal(
    isHumanMessage({ role: "user" }, [{ type: "text", text: "continue", synthetic: true }]),
    false,
  );
  assert.equal(
    isHumanMessage({ role: "user" }, [{ type: "text", text: softLimitMessage(83) }]),
    false,
  );
  assert.equal(
    isHumanMessage({ role: "user" }, [
      { type: "text", text: "Unattended session paused: 30 minutes without a human message." },
    ]),
    false,
  );
  assert.equal(isHumanMessage({ role: "assistant" }, [{ type: "text", text: "hi" }]), false);
});

test("the model-visible notice names request_more_budget before exhaustion", () => {
  assert.equal(
    softLimitMessage(83),
    "Allowance: 83% of today's budget used. If you need more for this task, call request_more_budget now, before it runs out.",
  );
});
