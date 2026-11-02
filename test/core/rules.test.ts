import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant, Member, Rule } from "../../src/contracts.ts";
import { buildRequest } from "../../src/core/requests.ts";
import { findMatchingRule, ruleNote } from "../../src/core/rules.ts";

const NOW = new Date("2026-10-05T09:00:00Z");

const member: Member = {
  id: "mem_1",
  teamId: "team_1",
  displayName: "Lena",
  email: null,
  role: "member",
  keyAlias: "taa-mem_1",
  keyHash: "hash",
  blocked: false,
  blockedReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function request(
  overrides: {
    kind?: "more_budget" | "model_unlock" | "suggestion";
    amountUsd?: number;
    modelId?: string;
  } = {},
) {
  return buildRequest({
    id: "req_1",
    member,
    kind: overrides.kind ?? "more_budget",
    message: "please",
    context: { spendThisPeriodUsd: 18, limitUsd: 20, topModels: [], last7DaysUsd: 30 },
    now: NOW,
    ...(overrides.amountUsd === undefined ? { amountUsd: 5 } : { amountUsd: overrides.amountUsd }),
    ...(overrides.modelId === undefined ? {} : { modelId: overrides.modelId }),
  });
}

const budgetRule: Rule = {
  id: "rule_topup",
  teamId: "team_1",
  name: "+USD 10 once per 7 days",
  enabled: true,
  condition: { kind: "budget_topup", maxUsd: 10, oncePerDays: 7 },
  createdAt: "2026-10-01T00:00:00.000Z",
};

const modelRule: Rule = {
  id: "rule_cheap",
  teamId: "team_1",
  name: "cheap models always open",
  enabled: true,
  condition: { kind: "model_unlock", modelIds: ["flagship"], durationHours: 24 },
  createdAt: "2026-10-02T00:00:00.000Z",
};

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "grn_1",
    memberId: "mem_1",
    scope: "budget",
    amountUsd: 5,
    modelId: null,
    tokenCap: null,
    requestId: "req_0",
    issuedBy: "rule",
    issuedById: "rule_topup",
    startsAt: "2026-10-04T09:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-10-04T09:00:00.000Z",
    ...overrides,
  };
}

test("a budget rule approves a request within its cap", () => {
  const match = findMatchingRule({
    request: request({ amountUsd: 7 }),
    rules: [budgetRule],
    grants: [],
    now: NOW,
  });
  assert.ok(match);
  assert.equal(match.rule.id, "rule_topup");
  assert.equal(match.amountUsd, 7);
  assert.equal(match.until, null);
  assert.match(ruleNote(match), /Auto-approved by rule/);
});

test("a budget rule does not approve above its cap", () => {
  const match = findMatchingRule({
    request: request({ amountUsd: 11 }),
    rules: [budgetRule],
    grants: [],
    now: NOW,
  });
  assert.equal(match, null);
});

test("the once-per-7-days window counts rule grants only", () => {
  const recent = findMatchingRule({
    request: request(),
    rules: [budgetRule],
    grants: [grant({ createdAt: "2026-10-04T09:00:00.000Z" })],
    now: NOW,
  });
  assert.equal(recent, null);

  const managerGrant = findMatchingRule({
    request: request(),
    rules: [budgetRule],
    grants: [grant({ issuedBy: "manager", issuedById: "user_priya" })],
    now: NOW,
  });
  assert.ok(managerGrant);

  const old = findMatchingRule({
    request: request(),
    rules: [budgetRule],
    grants: [grant({ createdAt: "2026-09-27T09:00:00.000Z" })],
    now: NOW,
  });
  assert.ok(old);
});

test("a rule from another team or a disabled rule never matches", () => {
  const otherTeam = findMatchingRule({
    request: request(),
    rules: [{ ...budgetRule, teamId: "team_2" }],
    grants: [],
    now: NOW,
  });
  assert.equal(otherTeam, null);

  const disabled = findMatchingRule({
    request: request(),
    rules: [{ ...budgetRule, enabled: false }],
    grants: [],
    now: NOW,
  });
  assert.equal(disabled, null);
});

test("a model rule opens a listed model for its fixed duration", () => {
  const match = findMatchingRule({
    request: request({ kind: "model_unlock", modelId: "flagship" }),
    rules: [modelRule],
    grants: [],
    now: NOW,
  });
  assert.ok(match);
  assert.equal(match.modelId, "flagship");
  assert.equal(match.until, "2026-10-06T09:00:00.000Z");

  const unlisted = findMatchingRule({
    request: request({ kind: "model_unlock", modelId: "other" }),
    rules: [modelRule],
    grants: [],
    now: NOW,
  });
  assert.equal(unlisted, null);
});

test("a model rule will not stack a second active grant", () => {
  const active = grant({
    scope: "model",
    amountUsd: null,
    modelId: "flagship",
    issuedById: "rule_cheap",
    expiresAt: "2026-10-06T09:00:00.000Z",
  });
  const match = findMatchingRule({
    request: request({ kind: "model_unlock", modelId: "flagship" }),
    rules: [modelRule],
    grants: [active],
    now: NOW,
  });
  assert.equal(match, null);

  const expired = findMatchingRule({
    request: request({ kind: "model_unlock", modelId: "flagship" }),
    rules: [modelRule],
    grants: [{ ...active, expiresAt: "2026-10-05T08:59:59.000Z" }],
    now: NOW,
  });
  assert.ok(expired);
});

test("rules are kind-specific and the first match wins", () => {
  const wrongKind = findMatchingRule({
    request: request({ kind: "model_unlock", modelId: "flagship" }),
    rules: [budgetRule],
    grants: [],
    now: NOW,
  });
  assert.equal(wrongKind, null);

  const first = findMatchingRule({
    request: request(),
    rules: [budgetRule, { ...budgetRule, id: "rule_second", name: "second" }],
    grants: [],
    now: NOW,
  });
  assert.equal(first?.rule.id, "rule_topup");
});

test("a decided request is not auto-approved", () => {
  const decided = { ...request(), state: "approved" as const };
  assert.equal(
    findMatchingRule({ request: decided, rules: [budgetRule], grants: [], now: NOW }),
    null,
  );
});
