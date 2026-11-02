import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlService, randomIds } from "../../src/core/index.ts";
import type { IntervalScheduler } from "../../src/core/reconciler.ts";
import { createControlPort } from "../../src/server/control.ts";
import { RecordingNotifier } from "../core/fakes.ts";
import { seedTwoTeams } from "./harness.ts";

function fakeScheduler(): IntervalScheduler & { tick(): void; running: boolean } {
  const callbacks: Array<() => void> = [];
  return {
    running: false,
    setInterval(fn) {
      callbacks.push(fn);
      this.running = true;
      return callbacks.length;
    },
    clearInterval() {
      this.running = false;
    },
    tick() {
      for (const callback of callbacks) callback();
    },
  };
}

test("a manager from another team cannot change limits, models, blocks or requests", async () => {
  const fixture = await seedTwoTeams();
  try {
    await assert.rejects(
      fixture.control.setLimits(fixture.managerA, fixture.memberB.id, { budgetUsd: 999 }),
      /another team/,
    );
    await assert.rejects(
      fixture.control.setModels(fixture.managerA, fixture.memberB.id, ["mock-cheap"]),
      /another team/,
    );
    await assert.rejects(
      fixture.control.blockKey(fixture.managerA, fixture.memberB.id, "because"),
      /another team/,
    );
    await assert.rejects(
      fixture.control.rotateKey(fixture.managerA, fixture.memberB.id),
      /another team/,
    );
    const request = await fixture.control.createRequest({
      memberId: fixture.memberB.id,
      teamId: fixture.teamB.id,
      kind: "more_budget",
      amountUsd: 5,
      modelId: null,
      message: "please",
    });
    await assert.rejects(
      fixture.control.decideRequest(fixture.managerA, request.id, {
        outcome: "approved",
        note: null,
        amountUsd: null,
        modelId: null,
        until: null,
        permanent: false,
      }),
      /another team/,
    );
    // Nothing was written for the other team.
    const limits = await fixture.store.getLimits(fixture.memberB.id);
    assert.equal(limits?.budgetUsd, 20);
    assert.equal((await fixture.store.getRequest(request.id))?.state, "pending");
  } finally {
    fixture.close();
  }
});

test("a manager acts inside their own team", async () => {
  const fixture = await seedTwoTeams();
  try {
    const result = await fixture.control.setLimits(fixture.managerA, fixture.memberA.id, {
      budgetUsd: 33,
    });
    assert.equal(result.policy.effectiveBudgetUsd, 33);
  } finally {
    fixture.close();
  }
});

test("the team budget reaches the gateway and survives a restart as one team", async () => {
  const fixture = await seedTwoTeams();
  try {
    assert.equal(fixture.gateway.teams.size, 2);
    const updated = await fixture.control.updateTeam(fixture.admin, fixture.teamA.id, {
      monthlyBudgetUsd: 275,
    });
    assert.equal(updated.monthlyBudgetUsd, 275);
    const gatewayId = await fixture.store.getGatewayTeamId(fixture.teamA.id);
    assert.ok(gatewayId);
    assert.equal(fixture.gateway.teams.get(gatewayId)?.monthlyBudgetUsd, 275);

    // A restarted control service has no process-local map; the store keeps the
    // gateway id, so enrolment does not create a duplicate team.
    const service2 = new ControlService({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: randomIds(),
    });
    const control2 = createControlPort({
      store: fixture.store,
      gateway: fixture.gateway,
      service: service2,
      clock: fixture.clock,
      ids: randomIds(),
      controlUrl: "http://control.test",
      gatewayUrl: "http://gateway.test",
    });
    assert.equal(fixture.gateway.teams.size, 2);
    const enrolled = await control2.createMember(fixture.admin, fixture.teamA.id, {
      displayName: "New",
      email: null,
      role: "member",
      limits: { budgetUsd: 5, period: "monthly", tokenCap: null, rpm: null, tpm: null },
    });
    assert.ok(enrolled.id);
    assert.equal(fixture.gateway.teams.size, 2);
  } finally {
    fixture.close();
  }
});

test("deleting a team revokes its keys and deletes its gateway team", async () => {
  const fixture = await seedTwoTeams();
  try {
    const gatewayId = await fixture.store.getGatewayTeamId(fixture.teamB.id);
    assert.ok(gatewayId);
    await fixture.control.deleteTeam(fixture.admin, fixture.teamB.id);
    assert.equal(await fixture.store.getTeam(fixture.teamB.id), null);
    assert.equal(fixture.gateway.teams.has(gatewayId), false);
    const deleted = fixture.gateway.calls
      .filter((call) => call.method === "deleteKey")
      .map((call) => call.keyAlias);
    assert.ok(deleted.includes(fixture.memberB.keyAlias));
  } finally {
    fixture.close();
  }
});

test("deleting a member whose key is already gone still succeeds", async () => {
  const fixture = await seedTwoTeams();
  try {
    fixture.gateway.missingDeleteAliases.add(fixture.memberB.keyAlias);
    await fixture.control.deleteMember(fixture.admin, fixture.teamB.id, fixture.memberB.id);
    assert.equal(await fixture.store.getMember(fixture.memberB.id), null);
  } finally {
    fixture.close();
  }
});

test("a manager can enrol a member into their own team, and nothing else", async () => {
  const fixture = await seedTwoTeams();
  try {
    const created = await fixture.control.createMember(fixture.managerA, fixture.teamA.id, {
      displayName: "New member",
      email: null,
      role: "member",
      limits: { budgetUsd: 5, period: "monthly", tokenCap: null, rpm: null, tpm: null },
    });
    assert.equal(created.teamId, fixture.teamA.id);

    await assert.rejects(
      fixture.control.createMember(fixture.managerA, fixture.teamB.id, {
        displayName: "Wrong team",
        email: null,
        role: "member",
      }),
      /own team/,
    );
    await assert.rejects(
      fixture.control.createMember(fixture.managerA, fixture.teamA.id, {
        displayName: "Another manager",
        email: "x@example.test",
        role: "manager",
      }),
      /Only an admin/,
    );
  } finally {
    fixture.close();
  }
});

test("creating and deciding a request sends a manager notice and a member notice", async () => {
  const notifier = new RecordingNotifier();
  const fixture = await seedTwoTeams({ notifier });
  try {
    const created = await fixture.control.createRequest({
      memberId: fixture.memberA.id,
      teamId: fixture.teamA.id,
      kind: "more_budget",
      amountUsd: 5,
      modelId: null,
      message: "a migration needs a little more",
    });
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.sent[0]?.kind, "request_created");
    assert.equal(notifier.sent[0]?.audience, "manager");
    assert.equal(notifier.sent[0]?.memberId, fixture.memberA.id);

    await fixture.control.decideRequest(fixture.managerA, created.id, {
      outcome: "approved",
      note: "Approved for this week.",
      amountUsd: 5,
      modelId: null,
      until: null,
      permanent: false,
    });
    const decided = notifier.sent.filter((notice) => notice.kind === "request_decided");
    assert.equal(decided.length, 1);
    assert.equal(decided[0]?.audience, "member");
    assert.match(decided[0]?.body ?? "", /Approved for this week/);

    const audit = await fixture.store.listAudit({ teamId: fixture.teamA.id });
    const notices = audit.filter((event) => event.action === "notification.sent");
    assert.equal(notices.length, 2);
    const notice = notices[0];
    assert.ok(notice);
    assert.equal((notice.after as { teamId?: string }).teamId, fixture.teamA.id);
  } finally {
    fixture.close();
  }
});

test("the expiry loop is scheduled and expires a request after 72 hours", async () => {
  const fixture = await seedTwoTeams();
  try {
    const created = await fixture.control.createRequest({
      memberId: fixture.memberA.id,
      teamId: fixture.teamA.id,
      kind: "suggestion",
      amountUsd: null,
      modelId: null,
      message: "a thought",
    });
    const scheduler = fakeScheduler();
    const loop = fixture.service.startExpiryLoop({ intervalMs: 1000, scheduler });
    assert.equal(loop.isRunning(), true);

    fixture.clock.advanceHours(73);
    await loop.tick();
    assert.equal((await fixture.store.getRequest(created.id))?.state, "expired");
    const audit = await fixture.store.listAudit({ teamId: fixture.teamA.id });
    assert.ok(audit.some((event) => event.action === "request.expired"));
    loop.stop();
    assert.equal(loop.isRunning(), false);
  } finally {
    fixture.close();
  }
});
