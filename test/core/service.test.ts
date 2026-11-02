import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rule } from "../../src/contracts.ts";
import { AUDIT_ACTIONS } from "../../src/core/audit.ts";
import { DomainError } from "../../src/core/errors.ts";
import type { StaffActor } from "../../src/core/service.ts";
import { type Fixture, makeFixture } from "./fakes.ts";

function managerFor(fixture: Fixture): StaffActor {
  return {
    type: "manager",
    id: "user_priya",
    role: "manager",
    displayName: "Priya",
    teamId: fixture.team.id,
  };
}

function budgetRule(teamId: string): Rule {
  return {
    id: "rule_topup",
    teamId,
    name: "+USD 10 once per 7 days",
    enabled: true,
    condition: { kind: "budget_topup", maxUsd: 10, oncePerDays: 7 },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function modelRule(teamId: string): Rule {
  return {
    id: "rule_cheap",
    teamId,
    name: "cheap models always open",
    enabled: true,
    condition: { kind: "model_unlock", modelIds: ["flagship"], durationHours: 1 },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

test("create attaches live context and leaves the request pending without a rule", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.addSpend(12.5, "gpt-6-luna");
    await fixture.addSpend(1.5, "deepseek-v4.1-flash");

    const result = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "a migration needs a bit more",
    });
    assert.equal(result.request.state, "pending");
    assert.equal(result.decision, null);
    assert.equal(result.grant, null);
    assert.equal(result.request.context.spendThisPeriodUsd, 14);
    assert.equal(result.request.context.limitUsd, 20);
    assert.equal(result.request.context.last7DaysUsd, 14);
    assert.deepEqual(result.request.context.topModels, [
      { modelId: "gpt-6-luna", spendUsd: 12.5 },
      { modelId: "deepseek-v4.1-flash", spendUsd: 1.5 },
    ]);

    const events = await fixture.store.listAudit({});
    assert.deepEqual(
      events.map((event) => event.action),
      [AUDIT_ACTIONS.requestCreated, AUDIT_ACTIONS.keyStateApplied],
    );
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 21);
  } finally {
    fixture.close();
  }
});

test("an auto-approve rule logs the rule, creates the grant and reconciles", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.store.upsertRule(budgetRule(fixture.team.id));
    const result = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });

    assert.equal(result.request.state, "approved");
    assert.ok(result.decision);
    assert.equal(result.decision.source, "rule");
    assert.equal(result.decision.decidedById, "rule_topup");
    assert.equal(result.decision.decidedByRole, "rule");
    assert.equal(result.grant?.issuedBy, "rule");
    assert.equal(result.grant?.issuedById, "rule_topup");
    assert.equal(result.grant?.expiresAt, "2026-10-06T00:00:00.000Z");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 26.25);

    const events = await fixture.store.listAudit({});
    assert.deepEqual(
      events.map((event) => event.action),
      [
        AUDIT_ACTIONS.requestCreated,
        AUDIT_ACTIONS.requestDecided,
        AUDIT_ACTIONS.grantIssued,
        AUDIT_ACTIONS.keyStateApplied,
      ],
    );
    const decided = events[1];
    assert.equal(decided?.actor.type, "rule");
    assert.equal(decided?.actor.id, "rule_topup");
    assert.match(decided?.reason ?? "", /Auto-approved by rule/);

    const teamEvents = await fixture.store.listAudit({ teamId: fixture.team.id });
    assert.deepEqual(
      teamEvents.map((event) => event.action),
      [
        AUDIT_ACTIONS.requestCreated,
        AUDIT_ACTIONS.requestDecided,
        AUDIT_ACTIONS.grantIssued,
        AUDIT_ACTIONS.keyStateApplied,
      ],
    );

    const policy = await fixture.service.effectivePolicy(fixture.member.id);
    assert.equal(policy.effectiveBudgetUsd, 25);
    assert.equal(policy.status, "ok");
  } finally {
    fixture.close();
  }
});

test("the once-per-7-days limit allows exactly one rule approval in the window", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.store.upsertRule(budgetRule(fixture.team.id));
    const first = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "first",
    });
    assert.equal(first.request.state, "approved");

    const second = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "second",
    });
    assert.equal(second.request.state, "pending");
    assert.equal(second.decision, null);

    fixture.clock.advanceDays(7);
    fixture.clock.advanceMs(1);
    const third = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "next week",
    });
    assert.equal(third.request.state, "approved");
  } finally {
    fixture.close();
  }
});

test("a manager decision approves, grants and reconciles the key", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });
    fixture.gateway.resetCalls();

    const result = await fixture.service.decide(created.request.id, managerFor(fixture), {
      outcome: "approved",
      note: "ok",
    });
    assert.equal(result.request.state, "approved");
    assert.equal(result.decision.source, "manager");
    assert.equal(result.decision.grantedAmountUsd, 5);
    assert.equal(fixture.gateway.calls[0]?.method, "updateKey");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 26.25);

    const stored = await fixture.store.getRequest(created.request.id);
    assert.equal(stored?.state, "approved");
    assert.equal(stored?.decidedAt, "2026-10-05T09:00:00.000Z");
    const decisions = await fixture.store.listDecisions(created.request.id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.note, "ok");
  } finally {
    fixture.close();
  }
});

test("a partial approval can be revoked, which restores the budget", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 10,
      message: "ten please",
    });
    const decided = await fixture.service.decide(created.request.id, managerFor(fixture), {
      outcome: "partly_approved",
      amountUsd: 3,
      note: "three is enough",
    });
    assert.equal(decided.request.state, "partly_approved");
    assert.equal(decided.grant?.amountUsd, 3);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 24.15);

    assert.ok(decided.grant);
    const revoked = await fixture.service.revokeGrant(
      decided.grant.id,
      managerFor(fixture),
      "no longer needed",
    );
    assert.ok(revoked.revokedAt);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 21);
    const events = await fixture.store.listAudit({});
    assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.grantRevoked).length, 1);

    const again = await fixture.service.revokeGrant(decided.grant.id, managerFor(fixture), "again");
    assert.equal(again.revokedAt, revoked.revokedAt);
    const after = await fixture.store.listAudit({});
    assert.equal(after.filter((event) => event.action === AUDIT_ACTIONS.grantRevoked).length, 1);
  } finally {
    fixture.close();
  }
});

test("a model grant is applied, then removed by expiry and reconcile", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "model_unlock",
      modelId: "flagship",
      message: "hard parsing task",
    });
    const decided = await fixture.service.decide(created.request.id, managerFor(fixture), {
      outcome: "approved",
      until: "2026-10-05T09:15:00.000Z",
      note: "fifteen minutes",
    });
    assert.equal(decided.grant?.scope, "model");
    assert.equal(decided.grant?.expiresAt, "2026-10-05T09:15:00.000Z");
    assert.deepEqual(fixture.gateway.state.get(fixture.member.keyAlias)?.models, [
      "deepseek-v4.1-flash",
      "flagship",
      "gpt-6-luna",
    ]);

    fixture.clock.advanceMs(15 * 60 * 1000);
    const expiry = await fixture.service.expireDue();
    assert.equal(expiry.expiredGrants.length, 1);
    assert.deepEqual(fixture.gateway.state.get(fixture.member.keyAlias)?.models, [
      "deepseek-v4.1-flash",
      "gpt-6-luna",
    ]);
    const events = await fixture.store.listAudit({});
    assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.grantExpired).length, 1);

    const second = await fixture.service.expireDue();
    assert.equal(second.expiredGrants.length, 0);
    assert.equal(second.reconcile, null);
    const after = await fixture.store.listAudit({});
    assert.equal(after.filter((event) => event.action === AUDIT_ACTIONS.grantExpired).length, 1);
  } finally {
    fixture.close();
  }
});

test("a model rule auto-approves an unlock for its fixed duration", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.store.upsertRule(modelRule(fixture.team.id));
    const result = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "model_unlock",
      modelId: "flagship",
      message: "hard parsing task",
    });
    assert.equal(result.request.state, "approved");
    assert.equal(result.grant?.expiresAt, "2026-10-05T10:00:00.000Z");
    assert.ok(fixture.gateway.state.get(fixture.member.keyAlias)?.models.includes("flagship"));
  } finally {
    fixture.close();
  }
});

test("a pending request expires after 72 hours and cannot be decided", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });

    fixture.clock.advanceHours(72);
    const expiry = await fixture.service.expireDue();
    assert.equal(expiry.expiredRequests.length, 1);
    const stored = await fixture.store.getRequest(created.request.id);
    assert.equal(stored?.state, "expired");
    assert.equal(stored?.decidedAt, null);
    const events = await fixture.store.listAudit({});
    assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.requestExpired).length, 1);
  } finally {
    fixture.close();
  }
});

test("deciding a request past its deadline expires it and refuses", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });
    fixture.clock.advanceHours(73);
    const error = await fixture.service
      .decide(created.request.id, managerFor(fixture), { outcome: "approved" })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "expired");
    const stored = await fixture.store.getRequest(created.request.id);
    assert.equal(stored?.state, "expired");
  } finally {
    fixture.close();
  }
});

test("a member can cancel their own pending request only", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "suggestion",
      message: "could we add a cheaper model?",
    });
    const cancelled = await fixture.service.cancel(created.request.id, fixture.member.id);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(
      (await fixture.store.listAudit({})).at(-1)?.action,
      AUDIT_ACTIONS.requestCancelled,
    );

    const error = await fixture.service
      .cancel(created.request.id, "mem_someone_else")
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "forbidden");
  } finally {
    fixture.close();
  }
});

test("a decided request cannot be decided or cancelled again", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });
    await fixture.service.decide(created.request.id, managerFor(fixture), { outcome: "denied" });
    await assert.rejects(
      fixture.service.decide(created.request.id, managerFor(fixture), { outcome: "approved" }),
      /not pending/,
    );
    await assert.rejects(
      fixture.service.cancel(created.request.id, fixture.member.id),
      /not pending/,
    );
  } finally {
    fixture.close();
  }
});

test("model requests are checked against the catalogue", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      fixture.service.createRequest({
        memberId: fixture.member.id,
        kind: "model_unlock",
        modelId: "blocked-model",
        message: "please",
      }),
      /catalogue/,
    );
    await assert.rejects(
      fixture.service.createRequest({
        memberId: fixture.member.id,
        kind: "model_unlock",
        modelId: "not-a-model",
        message: "please",
      }),
      /catalogue/,
    );
  } finally {
    fixture.close();
  }
});

test("pending requests do not churn the gateway; every mutation is audited", async () => {
  const fixture = await makeFixture();
  try {
    const first = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "suggestion",
      message: "one",
    });
    const callsAfterFirst = fixture.gateway.calls.length;
    const auditedAfterFirst = (await fixture.store.listAudit({})).length;

    await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "suggestion",
      message: "two",
    });
    assert.equal(fixture.gateway.calls.length, callsAfterFirst);
    assert.equal((await fixture.store.listAudit({})).length, auditedAfterFirst + 1);

    await fixture.service.cancel(first.request.id, fixture.member.id);
    assert.equal((await fixture.store.listAudit({})).length, auditedAfterFirst + 2);
  } finally {
    fixture.close();
  }
});

test("a rule-issued grant can be revoked by a manager", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.store.upsertRule(budgetRule(fixture.team.id));
    const result = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });
    assert.ok(result.grant);
    assert.equal(result.grant.issuedBy, "rule");
    await fixture.service.revokeGrant(result.grant.id, managerFor(fixture), "revoked by policy");
    const policy = await fixture.service.effectivePolicy(fixture.member.id);
    assert.equal(policy.effectiveBudgetUsd, 20);
  } finally {
    fixture.close();
  }
});

test("a non-staff actor cannot decide or revoke", async () => {
  const fixture = await makeFixture();
  try {
    const created = await fixture.service.createRequest({
      memberId: fixture.member.id,
      kind: "more_budget",
      amountUsd: 5,
      message: "please",
    });
    const memberActor = {
      type: "member" as const,
      id: fixture.member.id,
      role: "member" as const,
    };
    await assert.rejects(
      fixture.service.decide(created.request.id, memberActor as never, { outcome: "approved" }),
      /Only a manager or an admin/,
    );
    await assert.rejects(
      fixture.service.revokeGrant("grn_missing", memberActor as never, "no"),
      /Only a manager or an admin/,
    );
    await assert.rejects(
      fixture.service.setMemberLimits(
        fixture.member.id,
        { budgetUsd: 1, period: "daily", tokenCap: null, rpm: null, tpm: null },
        memberActor as never,
      ),
      /Only a manager or an admin/,
    );
  } finally {
    fixture.close();
  }
});

test("limit and model changes are audited and reconciled", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.service.reconcile();
    const limits = await fixture.service.setMemberLimits(
      fixture.member.id,
      { budgetUsd: 30, period: "daily", tokenCap: 5000, rpm: 10, tpm: 2000 },
      managerFor(fixture),
      "more room",
    );
    assert.equal(limits.budgetUsd, 30);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 31.5);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.rpmLimit, 10);
    const events = await fixture.store.listAudit({ objectType: "limits" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, AUDIT_ACTIONS.limitsUpdated);
    assert.equal(events[0]?.reason, "more room");
    assert.equal((events[0]?.before as { budgetUsd?: number } | null)?.budgetUsd, 20);
    assert.equal((events[0]?.after as { budgetUsd?: number } | null)?.budgetUsd, 30);

    const models = await fixture.service.setMemberModels(
      fixture.member.id,
      ["gpt-6-luna"],
      managerFor(fixture),
      "just luna",
    );
    assert.deepEqual(models, ["gpt-6-luna"]);
    assert.deepEqual(fixture.gateway.state.get(fixture.member.keyAlias)?.models, ["gpt-6-luna"]);
    const modelEvents = await fixture.store.listAudit({ objectType: "member_models" });
    assert.equal(modelEvents.length, 1);
    assert.deepEqual(modelEvents[0]?.after, ["gpt-6-luna"]);

    await assert.rejects(
      fixture.service.setMemberModels(fixture.member.id, ["no-such-model"], managerFor(fixture)),
      /Unknown model/,
    );
    await assert.rejects(
      fixture.service.setMemberLimits(
        fixture.member.id,
        { budgetUsd: -1, period: "daily", tokenCap: null, rpm: null, tpm: null },
        managerFor(fixture),
      ),
      /zero or more/,
    );
  } finally {
    fixture.close();
  }
});

test("rule and team-policy changes are audited, and a policy change can block", async () => {
  const fixture = await makeFixture();
  try {
    const rule = budgetRule(fixture.team.id);
    await fixture.service.upsertRule(rule, managerFor(fixture), "new rule");
    assert.deepEqual(await fixture.store.listRules(fixture.team.id), [rule]);
    const upserted = await fixture.store.listAudit({ objectType: "rule" });
    assert.equal(upserted[0]?.action, AUDIT_ACTIONS.ruleUpserted);
    assert.equal(upserted[0]?.reason, "new rule");

    await fixture.service.deleteRule(rule.id, managerFor(fixture), "no longer needed");
    assert.deepEqual(await fixture.store.listRules(fixture.team.id), []);
    const deleted = await fixture.store.listAudit({ objectType: "rule" });
    assert.equal(deleted[1]?.action, AUDIT_ACTIONS.ruleDeleted);

    await fixture.addSpend(18);
    const policy = await fixture.store.getTeamPolicy(fixture.team.id);
    assert.ok(policy);
    await fixture.service.setTeamPolicy(
      { ...policy, thresholds: { softRatio: 0.5, graceRatio: 0.05 } },
      managerFor(fixture),
      "tighter warning",
    );
    const effective = await fixture.service.effectivePolicy(fixture.member.id);
    assert.equal(effective.status, "soft");
    const policyEvents = await fixture.store.listAudit({ objectType: "team_policy" });
    assert.equal(policyEvents.length, 1);
    assert.equal(policyEvents[0]?.action, AUDIT_ACTIONS.teamPolicyUpdated);
  } finally {
    fixture.close();
  }
});

test("blocking and unblocking a member reconciles the key and is audited", async () => {
  const fixture = await makeFixture();
  try {
    await fixture.service.reconcile();
    const blocked = await fixture.service.setMemberBlocked(
      fixture.member.id,
      true,
      managerFor(fixture),
      "off-hours cap",
    );
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.blockedReason, "off-hours cap");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.blocked, true);
    const blockedEvents = await fixture.store.listAudit({ objectType: "member" });
    assert.equal(blockedEvents.length, 1);
    assert.equal(blockedEvents[0]?.action, AUDIT_ACTIONS.memberBlocked);

    const unchanged = await fixture.service.setMemberBlocked(
      fixture.member.id,
      true,
      managerFor(fixture),
      "off-hours cap",
    );
    assert.equal(unchanged.blocked, true);
    assert.equal((await fixture.store.listAudit({ objectType: "member" })).length, 1);

    const unblocked = await fixture.service.setMemberBlocked(
      fixture.member.id,
      false,
      managerFor(fixture),
    );
    assert.equal(unblocked.blocked, false);
    assert.equal(unblocked.blockedReason, null);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.blocked, false);
    const events = await fixture.store.listAudit({ objectType: "member" });
    assert.equal(events[1]?.action, AUDIT_ACTIONS.memberUnblocked);
  } finally {
    fixture.close();
  }
});

test("a member block audit event does not publish the key hash", async () => {
  const fixture = await makeFixture();
  try {
    const member = await fixture.store.getMember(fixture.member.id);
    assert.ok(member?.keyHash);
    await fixture.service.setMemberBlocked(fixture.member.id, true, managerFor(fixture), "test");
    const events = await fixture.store.listAudit({ objectType: "member" });
    const blocked = events.find((event) => event.action === AUDIT_ACTIONS.memberBlocked);
    assert.ok(blocked);
    assert.equal((blocked.after as { keyHash?: string }).keyHash, undefined);
    assert.equal((blocked.before as { keyHash?: string }).keyHash, undefined);
  } finally {
    fixture.close();
  }
});
