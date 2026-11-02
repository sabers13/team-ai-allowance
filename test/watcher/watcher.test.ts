import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWatcherBlockReason } from "../../src/watcher/caps.ts";
import { makeWatchFixture } from "./harness.ts";

const MONDAY = "2026-10-05T08:00:00.000Z"; // 10:00 in Berlin, working hours

test("the soft threshold is sent once per period and again in the next period", async () => {
  const fx = await makeWatchFixture({ start: MONDAY });
  try {
    fx.addSpend({ requestId: "gw_soft_1", costUsd: 8 });
    const watcher = fx.watcher();
    await watcher.tick();
    assert.equal(fx.notifier.byKind("soft_limit").length, 1);
    assert.equal(fx.notifier.byKind("grace").length, 0);

    await watcher.tick();
    assert.equal(fx.notifier.byKind("soft_limit").length, 1, "same period, same notice");

    fx.clock.set("2026-10-06T08:00:00.000Z");
    fx.addSpend({ requestId: "gw_soft_2", costUsd: 8.2 });
    await watcher.tick();
    assert.equal(fx.notifier.byKind("soft_limit").length, 2, "a new period may notify again");
  } finally {
    fx.close();
  }
});

test("a second watcher reads the notification audit and does not repeat a period notice", async () => {
  const fx = await makeWatchFixture({ start: MONDAY });
  try {
    fx.addSpend({ requestId: "gw_restart", costUsd: 8 });
    await fx.watcher().tick();
    assert.equal(fx.notifier.byKind("soft_limit").length, 1);

    await fx.watcher().tick();
    assert.equal(fx.notifier.byKind("soft_limit").length, 1);
    const audit = await fx.store.listAudit({ objectType: "notification" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor.type, "watcher");
  } finally {
    fx.close();
  }
});

test("the hard limit blocks the key through the reconciler and alerts the manager", async () => {
  const fx = await makeWatchFixture({ start: MONDAY });
  try {
    fx.addSpend({ requestId: "gw_hard", costUsd: 10.5 });
    const result = await fx.watcher().tick();
    assert.equal(result.reconciled, true);
    assert.deepEqual(result.blocked, []);

    const member = await fx.latestMember();
    assert.equal(member.blocked, false, "the watcher does not own the hard-limit block");
    const state = fx.gateway.state.get(`taa-${fx.memberId}`);
    assert.equal(state?.blocked, true, "the reconciler blocked the gateway key");

    assert.equal(fx.notifier.byKind("soft_limit").length, 1);
    assert.equal(fx.notifier.byKind("grace").length, 1);
    assert.equal(fx.notifier.byKind("hard_limit").length, 1);
    const managerNotice = fx.notifier
      .byKind("member_blocked")
      .find((notice) => notice.audience === "manager");
    assert.ok(managerNotice !== undefined);
    assert.match(managerNotice.body, /hard limit/u);
  } finally {
    fx.close();
  }
});

test("the token cap blocks the key, audits the watcher and unblocks at the next period", async () => {
  const fx = await makeWatchFixture({ start: MONDAY, tokenCap: 100 });
  try {
    fx.addSpend({ requestId: "gw_tok_1", costUsd: 0.01, tokens: 60 });
    fx.addSpend({ requestId: "gw_tok_2", costUsd: 0.01, tokens: 60 });
    const watcher = fx.watcher();
    const result = await watcher.tick();
    assert.deepEqual(result.blocked, [fx.memberId]);

    const blocked = await fx.latestMember();
    assert.equal(blocked.blocked, true);
    assert.match(blocked.blockedReason ?? "", /token cap reached/u);
    const parsed = parseWatcherBlockReason(blocked.blockedReason);
    assert.equal(parsed?.kind, "token_cap");
    assert.equal(parsed?.until.toISOString(), "2026-10-06T00:00:00.000Z");
    assert.equal(fx.gateway.state.get(`taa-${fx.memberId}`)?.blocked, true);
    assert.equal(fx.notifier.byKind("member_blocked").length, 2);

    const audit = await fx.store.listAudit({ objectType: "member" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "watcher.token_cap_block");
    assert.equal(audit[0]?.actor.type, "watcher");

    fx.clock.set("2026-10-06T00:00:10.000Z");
    const after = await watcher.tick();
    assert.deepEqual(after.unblocked, [fx.memberId]);
    const unblocked = await fx.latestMember();
    assert.equal(unblocked.blocked, false);
    assert.equal(unblocked.blockedReason, null);
    assert.equal(fx.gateway.state.get(`taa-${fx.memberId}`)?.blocked, false);
    const unblockAudit = await fx.store.listAudit({ objectType: "member" });
    assert.equal(unblockAudit.at(-1)?.action, "watcher.unblocked");
  } finally {
    fx.close();
  }
});

test("the off-hours cap blocks until the next working start, then unblocks", async () => {
  const fx = await makeWatchFixture({ start: "2026-10-09T18:00:00.000Z", offHours: { capUsd: 5 } });
  try {
    fx.addSpend({ requestId: "gw_off_1", costUsd: 6 });
    const watcher = fx.watcher();
    const result = await watcher.tick();
    assert.deepEqual(result.blocked, [fx.memberId]);

    const blocked = await fx.latestMember();
    assert.equal(blocked.blocked, true);
    assert.match(blocked.blockedReason ?? "", /off-hours cap reached/u);
    const parsed = parseWatcherBlockReason(blocked.blockedReason);
    assert.equal(parsed?.kind, "off_hours");
    assert.equal(parsed?.until.toISOString(), "2026-10-12T05:00:00.000Z");
    assert.equal(fx.gateway.state.get(`taa-${fx.memberId}`)?.blocked, true);

    const notices = fx.notifier.byKind("off_hours_block");
    assert.equal(notices.length, 2, "member and manager are told");
    assert.deepEqual(notices.map((notice) => notice.audience).sort(), ["manager", "member"]);
    assert.match(notices[0]?.body ?? "", /USD 6\.00/u);

    fx.clock.set("2026-10-12T04:59:59.000Z");
    const stillBlocked = await watcher.tick();
    assert.deepEqual(stillBlocked.unblocked, []);
    assert.equal((await fx.latestMember()).blocked, true);

    fx.clock.set("2026-10-12T05:00:01.000Z");
    const released = await watcher.tick();
    assert.deepEqual(released.unblocked, [fx.memberId]);
    assert.equal((await fx.latestMember()).blocked, false);
    assert.equal(fx.gateway.state.get(`taa-${fx.memberId}`)?.blocked, false);
  } finally {
    fx.close();
  }
});

test("a manager's unblock holds for that off-hours stretch, not the next one", async () => {
  const fx = await makeWatchFixture({ start: "2026-10-09T18:00:00.000Z", offHours: { capUsd: 5 } });
  try {
    fx.addSpend({ requestId: "gw_manual_1", costUsd: 6 });
    const watcher = fx.watcher();
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, true);

    // The manager's route clears the member block; the watcher must not undo it.
    await fx.store.updateMember(fx.memberId, { blocked: false, blockedReason: null });
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, false);

    // A later off-hours stretch is a new segment and may block again.
    fx.clock.set("2026-10-16T18:00:00.000Z");
    fx.addSpend({ requestId: "gw_manual_2", costUsd: 6 });
    const result = await watcher.tick();
    assert.deepEqual(result.blocked, [fx.memberId]);
    assert.equal((await fx.latestMember()).blocked, true);
  } finally {
    fx.close();
  }
});

test("a manager's unblock survives a watcher restart for the same segment", async () => {
  const fx = await makeWatchFixture({ start: "2026-10-09T18:00:00.000Z", offHours: { capUsd: 5 } });
  try {
    fx.addSpend({ requestId: "gw_restart_block", costUsd: 6 });
    await fx.watcher().tick();
    assert.equal((await fx.latestMember()).blocked, true);

    // A route unblock writes this audit event and clears the member block.
    const at = fx.clock.now().toISOString();
    await fx.store.updateMember(fx.memberId, { blocked: false, blockedReason: null });
    await fx.store.appendAudit({
      id: "aud_manager_unblock",
      at,
      actor: { type: "manager", id: "user_priya", displayName: "Priya" },
      action: "member.unblocked",
      objectType: "member",
      objectId: fx.memberId,
      before: { blocked: true },
      after: { blocked: false },
      reason: "unblocked once",
    });

    fx.clock.set("2026-10-09T18:05:00.000Z");
    const afterRestart = await fx.watcher().tick();
    assert.deepEqual(afterRestart.blocked, []);
    assert.equal((await fx.latestMember()).blocked, false);
  } finally {
    fx.close();
  }
});

test("the unusual-spend rule fires once per member per day above the minimum", async () => {
  const fx = await makeWatchFixture({ start: MONDAY, unusualSpendMinUsd: 2 });
  try {
    for (let day = 21; day <= 30; day += 1) {
      await fx.addStoredUsage({
        id: `use_history_${day}`,
        costUsd: 0.1,
        at: `2026-09-${day}T10:00:00.000Z`,
      });
    }
    for (let day = 1; day <= 4; day += 1) {
      await fx.addStoredUsage({
        id: `use_history_oct_${day}`,
        costUsd: 0.1,
        at: `2026-10-0${day}T10:00:00.000Z`,
      });
    }
    fx.addSpend({ requestId: "gw_unusual", costUsd: 2.5 });
    const watcher = fx.watcher();
    await watcher.tick();
    const notices = fx.notifier.byKind("unusual_spend");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.audience, "manager");
    assert.match(notices[0]?.body ?? "", /14-day median USD 0\.10/u);

    await watcher.tick();
    assert.equal(fx.notifier.byKind("unusual_spend").length, 1);
  } finally {
    fx.close();
  }
});

test("the unusual-spend minimum is configurable per team", async () => {
  const fx = await makeWatchFixture({ start: MONDAY, unusualSpendMinUsd: 0.01 });
  try {
    fx.addSpend({ requestId: "gw_small", costUsd: 0.02 });
    await fx.watcher().tick();
    assert.equal(fx.notifier.byKind("unusual_spend").length, 1);
  } finally {
    fx.close();
  }
});

test("a block before the DST start unblocks at the new local 07:00", async () => {
  const fx = await makeWatchFixture({
    start: "2026-03-27T19:00:00.000Z", // Friday 20:00 CET
    offHours: { capUsd: 5 },
  });
  try {
    fx.addSpend({ requestId: "gw_dst", costUsd: 6 });
    const watcher = fx.watcher();
    await watcher.tick();
    const blocked = await fx.latestMember();
    assert.equal(
      parseWatcherBlockReason(blocked.blockedReason)?.until.toISOString(),
      "2026-03-30T05:00:00.000Z",
    );

    fx.clock.set("2026-03-30T04:59:59.000Z");
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, true);

    fx.clock.set("2026-03-30T05:00:01.000Z");
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, false);
  } finally {
    fx.close();
  }
});

test("a holiday moves the automatic unblock to the next working day", async () => {
  const fx = await makeWatchFixture({
    start: "2026-10-23T18:00:00.000Z", // Friday 20:00 CEST
    offHours: { capUsd: 5, holidays: ["2026-10-26"] },
  });
  try {
    fx.addSpend({ requestId: "gw_holiday", costUsd: 6 });
    const watcher = fx.watcher();
    await watcher.tick();
    assert.equal(
      parseWatcherBlockReason((await fx.latestMember()).blockedReason)?.until.toISOString(),
      "2026-10-27T06:00:00.000Z",
    );

    fx.clock.set("2026-10-26T06:00:01.000Z");
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, true, "the holiday Monday stays blocked");

    fx.clock.set("2026-10-27T06:00:01.000Z");
    await watcher.tick();
    assert.equal((await fx.latestMember()).blocked, false);
  } finally {
    fx.close();
  }
});
