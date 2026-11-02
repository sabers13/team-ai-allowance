import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesiredKeyState } from "../../src/contracts.ts";
import { AUDIT_ACTIONS } from "../../src/core/audit.ts";
import { DomainError } from "../../src/core/errors.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import {
  desiredState,
  diff,
  type IntervalScheduler,
  loadDesiredState,
  Reconciler,
  ReconciliationLoop,
} from "../../src/core/reconciler.ts";
import { makeFixture, START } from "./fakes.ts";

const state: DesiredKeyState = {
  keyAlias: "taa-mem_1",
  models: ["flash", "luna"],
  maxBudgetUsd: 20,
  budgetDuration: "1d",
  tpmLimit: null,
  rpmLimit: null,
  blocked: false,
};

test("desiredState skips members without a key and is sorted by alias", async () => {
  const fixture = await makeFixture();
  try {
    const loaded = await loadDesiredState(fixture.store, fixture.clock.now());
    assert.deepEqual(
      loaded.desired.map((entry) => entry.keyAlias),
      [fixture.member.keyAlias],
    );
    assert.equal(loaded.desired[0]?.maxBudgetUsd, 21);
    assert.equal(loaded.policies.size, 1);
    assert.ok(loaded.refs.has(fixture.member.keyAlias));
  } finally {
    fixture.close();
  }
});

test("desiredState is pure and filters out members with no key hash", () => {
  const now = new Date(START);
  const base = {
    limits: { budgetUsd: 20, period: "daily" as const, tokenCap: null, rpm: null, tpm: null },
    modelSelection: [] as string[],
    spendThisPeriodUsd: 0,
    grants: [],
    member: {
      id: "mem_1",
      teamId: "team_1",
      displayName: "Lena",
      email: null,
      role: "member" as const,
      keyAlias: "taa-mem_1",
      keyHash: null,
      blocked: false,
      blockedReason: null,
      createdAt: START,
      updatedAt: START,
    },
  };
  assert.deepEqual(desiredState({ members: [base], catalogue: [], teamPolicies: [], now }), []);
});

test("diff reports nothing for equal state, ignoring model order", () => {
  assert.deepEqual(diff([state], [{ ...state, models: ["luna", "flash"] }]), []);
});

test("diff reports only the fields that changed, and every field for a new key", () => {
  const budget = diff([state], [{ ...state, maxBudgetUsd: 25 }]);
  assert.equal(budget.length, 1);
  assert.deepEqual(budget[0]?.fields, ["maxBudgetUsd"]);

  const many = diff([state], [{ ...state, models: ["flash"], blocked: true, rpmLimit: 5 }]);
  assert.deepEqual(many[0]?.fields, ["models", "rpmLimit", "blocked"]);

  const created = diff([], [state]);
  assert.deepEqual(created[0]?.fields, [
    "models",
    "maxBudgetUsd",
    "budgetDuration",
    "tpmLimit",
    "rpmLimit",
    "blocked",
  ]);
  assert.equal(created[0]?.before, null);
});

test("reconciler applies the first change, persists it and audits it", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    const first = await reconciler.run();
    assert.equal(first.changes.length, 1);
    assert.equal(first.applied.length, 1);
    assert.equal(first.gatewayCalls, 1);
    assert.equal(fixture.gateway.calls[0]?.method, "updateKey");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 21);
    const stored = await fixture.store.getKeyState(fixture.member.keyAlias);
    assert.deepEqual(stored?.models, ["deepseek-v4.1-flash", "gpt-6-luna"]);

    const audit = await fixture.store.listAudit({});
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, AUDIT_ACTIONS.keyStateApplied);
    assert.equal(audit[0]?.objectId, fixture.member.keyAlias);
    assert.equal(audit[0]?.actor.type, "reconciler");
  } finally {
    fixture.close();
  }
});

test("reconciler is idempotent: a second run makes no call and writes no event", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    await reconciler.run();
    fixture.gateway.resetCalls();

    const second = await reconciler.run();
    assert.deepEqual(second.changes, []);
    assert.deepEqual(second.applied, []);
    assert.equal(second.gatewayCalls, 0);
    assert.equal(fixture.gateway.calls.length, 0);
    assert.equal((await fixture.store.listAudit({})).length, 1);
  } finally {
    fixture.close();
  }
});

test("a limit change produces a minimal diff for that one key", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    await reconciler.run();
    fixture.gateway.resetCalls();

    const limits = await fixture.store.getLimits(fixture.member.id);
    assert.ok(limits);
    await fixture.store.setLimits(fixture.member.id, { ...limits, budgetUsd: 30 });

    const result = await reconciler.run();
    assert.equal(result.changes.length, 1);
    assert.deepEqual(result.changes[0]?.fields, ["maxBudgetUsd"]);
    assert.equal(result.gatewayCalls, 1);
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.maxBudgetUsd, 31.5);

    const third = await reconciler.run();
    assert.equal(third.gatewayCalls, 0);
  } finally {
    fixture.close();
  }
});

test("blocking a member blocks their key; unblocking releases it", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    await reconciler.run();
    fixture.gateway.resetCalls();

    await fixture.store.updateMember(fixture.member.id, { blocked: true });
    const blocked = await reconciler.run();
    assert.deepEqual(blocked.changes[0]?.fields, ["blocked"]);
    assert.equal(fixture.gateway.calls[0]?.method, "blockKey");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.blocked, true);

    await fixture.store.updateMember(fixture.member.id, { blocked: false });
    const released = await reconciler.run();
    assert.equal(released.gatewayCalls, 1);
    assert.equal(fixture.gateway.calls[1]?.method, "unblockKey");
    assert.equal(fixture.gateway.state.get(fixture.member.keyAlias)?.blocked, false);
  } finally {
    fixture.close();
  }
});

test("a gateway failure is audited, not persisted, and retried on the next run", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    fixture.gateway.failUpdates = true;
    const error = await reconciler.run().catch((caught: unknown) => caught);
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "gateway_failure");
    assert.equal(await fixture.store.getKeyState(fixture.member.keyAlias), null);
    const audit = await fixture.store.listAudit({});
    assert.equal(audit[0]?.action, AUDIT_ACTIONS.keyStateFailed);

    fixture.gateway.failUpdates = false;
    const retry = await reconciler.run();
    assert.equal(retry.applied.length, 1);
    assert.ok(await fixture.store.getKeyState(fixture.member.keyAlias));
  } finally {
    fixture.close();
  }
});

test("the loop registers one interval, runs a tick and stops", async () => {
  const fixture = await makeFixture();
  try {
    const reconciler = new Reconciler({
      store: fixture.store,
      gateway: fixture.gateway,
      clock: fixture.clock,
      ids: sequentialIds(),
    });
    let registered = 0;
    let cleared = 0;
    let fired: (() => void) | null = null;
    const scheduler: IntervalScheduler = {
      setInterval: (fn) => {
        registered += 1;
        fired = fn;
        return registered;
      },
      clearInterval: () => {
        cleared += 1;
      },
    };
    const loop = new ReconciliationLoop(reconciler, { intervalMs: 1234, scheduler });
    loop.start();
    loop.start();
    assert.equal(registered, 1);
    assert.equal(loop.isRunning(), true);

    await loop.tick();
    assert.equal(fixture.gateway.calls.length, 1);
    const second = await loop.tick();
    assert.equal(second?.gatewayCalls, 0);

    loop.stop();
    assert.equal(cleared, 1);
    assert.equal(loop.isRunning(), false);
    assert.ok(fired);
  } finally {
    fixture.close();
  }
});
