import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant, Limits, Member, ModelEntry, TeamPolicy } from "../../src/contracts.ts";
import {
  activeGrants,
  budgetDurationFor,
  computeDesiredKeyState,
  computeEffectivePolicy,
  computeStatus,
  defaultTeamPolicy,
  hardLimitUsd,
} from "../../src/core/policy.ts";

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

const limits: Limits = {
  budgetUsd: 20,
  period: "daily",
  tokenCap: null,
  rpm: null,
  tpm: null,
};

const catalogue: ModelEntry[] = [
  {
    id: "luna",
    displayName: "Luna",
    route: "mock/luna",
    inputPer1MUsd: 1,
    outputPer1MUsd: 2,
    state: "enabled",
    sortOrder: 1,
  },
  {
    id: "flash",
    displayName: "Flash",
    route: "mock/flash",
    inputPer1MUsd: 1,
    outputPer1MUsd: 2,
    state: "enabled",
    sortOrder: 2,
  },
  {
    id: "flagship",
    displayName: "Flagship",
    route: "mock/flagship",
    inputPer1MUsd: 10,
    outputPer1MUsd: 20,
    state: "approval-required",
    sortOrder: 3,
  },
  {
    id: "blocked",
    displayName: "Blocked",
    route: "mock/blocked",
    inputPer1MUsd: 1,
    outputPer1MUsd: 1,
    state: "blocked",
    sortOrder: 4,
  },
];

const teamPolicy: TeamPolicy = {
  ...defaultTeamPolicy("team_1", NOW),
  thresholds: { softRatio: 0.8, graceRatio: 0.05 },
};

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "grn_1",
    memberId: "mem_1",
    scope: "budget",
    amountUsd: 5,
    modelId: null,
    tokenCap: null,
    requestId: "req_1",
    issuedBy: "manager",
    issuedById: "user_priya",
    startsAt: "2026-10-05T08:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-10-05T08:00:00.000Z",
    ...overrides,
  };
}

function policy(
  overrides: {
    spend?: number;
    grants?: Grant[];
    selection?: string[];
    memberOverride?: Partial<Member>;
    limitsOverride?: Partial<Limits>;
  } = {},
) {
  return computeEffectivePolicy({
    member: { ...member, ...overrides.memberOverride },
    limits: { ...limits, ...overrides.limitsOverride },
    modelSelection: overrides.selection ?? [],
    catalogue,
    teamPolicy,
    grants: overrides.grants ?? [],
    spendThisPeriodUsd: overrides.spend ?? 0,
    now: NOW,
  });
}

test("allowed models: enabled entries, narrowed by the member's own list", () => {
  assert.deepEqual(policy().allowedModels, ["flash", "luna"]);
  assert.deepEqual(policy({ selection: ["flash"] }).allowedModels, ["flash"]);
  assert.deepEqual(policy({ selection: ["flagship"] }).allowedModels, []);
});

test("approval-required is included only with an active model grant", () => {
  assert.deepEqual(policy().allowedModels, ["flash", "luna"]);
  const unlocked = policy({
    grants: [grant({ scope: "model", amountUsd: null, modelId: "flagship" })],
  });
  assert.deepEqual(unlocked.allowedModels, ["flagship", "flash", "luna"]);
});

test("a blocked model stays blocked even with a grant, and unknown grants are ignored", () => {
  const blocked = policy({
    grants: [
      grant({ id: "grn_1", scope: "model", amountUsd: null, modelId: "blocked" }),
      grant({ id: "grn_2", scope: "model", amountUsd: null, modelId: "not-in-catalogue" }),
    ],
  });
  assert.deepEqual(blocked.allowedModels, ["flash", "luna"]);
});

test("expired, future and revoked grants are excluded before any sum", () => {
  const grants: Grant[] = [
    grant({ id: "active", amountUsd: 5 }),
    grant({ id: "expired", amountUsd: 100, expiresAt: "2026-10-05T09:00:00.000Z" }),
    grant({ id: "future", amountUsd: 100, startsAt: "2026-10-05T09:00:01.000Z" }),
    grant({ id: "revoked", amountUsd: 100, revokedAt: "2026-10-05T08:30:00.000Z" }),
  ];
  assert.deepEqual(
    activeGrants(grants, NOW).map((entry) => entry.id),
    ["active"],
  );
  assert.equal(policy({ grants }).effectiveBudgetUsd, 25);
});

test("budget grants add to the period budget and are rounded to cents", () => {
  const result = policy({
    grants: [grant({ id: "a", amountUsd: 0.01 }), grant({ id: "b", amountUsd: 0.02 })],
  });
  assert.equal(result.effectiveBudgetUsd, 20.03);
});

test("token cap: null stays null without grants, and adds token-cap grants", () => {
  assert.equal(policy().effectiveTokenCap, null);
  assert.equal(
    policy({ grants: [grant({ scope: "token_cap", amountUsd: null, tokenCap: 5000 })] })
      .effectiveTokenCap,
    5000,
  );
  assert.equal(
    policy({
      limitsOverride: { tokenCap: 1000 },
      grants: [grant({ scope: "token_cap", amountUsd: null, tokenCap: 250 })],
    }).effectiveTokenCap,
    1250,
  );
});

test("status crosses ok, soft, grace and blocked at the documented points", () => {
  assert.equal(policy({ spend: 0 }).status, "ok");
  assert.equal(policy({ spend: 15.99 }).status, "ok");
  assert.equal(policy({ spend: 16 }).status, "soft");
  assert.equal(policy({ spend: 19.99 }).status, "soft");
  assert.equal(policy({ spend: 20 }).status, "grace");
  assert.equal(policy({ spend: 20.99 }).status, "grace");
  assert.equal(policy({ spend: 21 }).status, "blocked");
  assert.equal(policy({ spend: 50 }).status, "blocked");
  assert.equal(policy({ spend: 21 }).blocked, true);
});

test("a blocked member or blocked key is blocked regardless of spend", () => {
  assert.equal(policy({ spend: 0, memberOverride: { blocked: true } }).status, "blocked");
  assert.equal(
    policy({ spend: 0, memberOverride: { blocked: true, blockedReason: "off-hours cap" } })
      .blockedReason,
    "off-hours cap",
  );
  const keyBlocked = computeEffectivePolicy({
    member,
    limits,
    modelSelection: [],
    catalogue,
    teamPolicy,
    grants: [],
    spendThisPeriodUsd: 0,
    now: NOW,
    keyBlocked: true,
  });
  assert.equal(keyBlocked.status, "blocked");
});

test("status uses the team's own thresholds", () => {
  assert.equal(
    computeStatus({
      effectiveBudgetUsd: 10,
      spendThisPeriodUsd: 5,
      thresholds: { softRatio: 0.5, graceRatio: 0.3 },
      memberBlocked: false,
    }),
    "soft",
  );
  assert.equal(hardLimitUsd(10, { softRatio: 0.5, graceRatio: 0.3 }), 13);
});

test("desired key state: sorted models, floored budget, gateway duration, block flag", () => {
  const desired = computeDesiredKeyState(
    policy({
      spend: 25,
      grants: [
        grant({ amountUsd: 0.114 }),
        grant({ id: "g2", scope: "model", amountUsd: null, modelId: "flagship" }),
      ],
      limitsOverride: { rpm: 10, tpm: 2000 },
    }),
  );
  assert.equal(desired.keyAlias, "taa-mem_1");
  assert.deepEqual(desired.models, ["flagship", "flash", "luna"]);
  assert.equal(desired.maxBudgetUsd, 21.11);
  assert.equal(desired.budgetDuration, "1d");
  assert.equal(desired.rpmLimit, 10);
  assert.equal(desired.tpmLimit, 2000);
  assert.equal(desired.blocked, true);
  assert.equal(budgetDurationFor("weekly"), "7d");
  assert.equal(budgetDurationFor("monthly"), "30d");
});

test("the gateway budget carries the team's grace headroom", () => {
  assert.equal(computeDesiredKeyState(policy(), 0.3).maxBudgetUsd, 26);
  assert.equal(computeDesiredKeyState(policy(), 0).maxBudgetUsd, 20);
});

test("the default team policy matches the specification", () => {
  const defaultPolicy = defaultTeamPolicy("team_1", NOW);
  assert.equal(defaultPolicy.thresholds.softRatio, 0.8);
  assert.equal(defaultPolicy.thresholds.graceRatio, 0.05);
  assert.equal(defaultPolicy.offHours.capUsd, 5);
  assert.equal(defaultPolicy.offHours.timeZone, "Europe/Berlin");
  assert.deepEqual(defaultPolicy.offHours.workingDays, [1, 2, 3, 4, 5]);
  assert.equal(defaultPolicy.unusualSpendMinUsd, 2);
});

test("the status uses the same floored hard limit as the gateway key", () => {
  const thresholds = { softRatio: 0.8, graceRatio: 0.3 };
  // USD 0.04 with 30% grace floors to USD 0.05 at the gateway.
  assert.equal(hardLimitUsd(0.04, thresholds), 0.05);
  assert.equal(
    computeStatus({
      effectiveBudgetUsd: 0.04,
      spendThisPeriodUsd: 0.051,
      thresholds,
      memberBlocked: false,
    }),
    "blocked",
  );
  assert.equal(
    computeStatus({
      effectiveBudgetUsd: 0.04,
      spendThisPeriodUsd: 0.049,
      thresholds,
      memberBlocked: false,
    }),
    "grace",
  );
});
