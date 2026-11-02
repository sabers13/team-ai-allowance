import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewaySpendRow, Member, TeamPolicy, UsageRow } from "../../src/contracts.ts";
import { defaultTeamPolicy } from "../../src/core/policy.ts";
import {
  aggregateUsage,
  dailyTotals,
  toUsageRows,
  usageSnapshot,
} from "../../src/watcher/spend.ts";

const HASH_LENA = "a".repeat(64);
const HASH_OMAR = "b".repeat(64);

function member(id: string, keyHash: string, displayName: string): Member {
  return {
    id,
    teamId: "team_1",
    displayName,
    email: null,
    role: "member",
    keyAlias: `taa-${id}`,
    keyHash,
    blocked: false,
    blockedReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function spendRow(overrides: Partial<GatewaySpendRow> = {}): GatewaySpendRow {
  return {
    requestId: "gw_1",
    keyHash: HASH_LENA,
    teamId: "team_1",
    userId: "mem_1",
    model: "gpt-6-luna",
    spendUsd: 1,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    startedAt: "2026-10-07T08:00:00.000Z",
    endedAt: "2026-10-07T08:00:01.000Z",
    ...overrides,
  };
}

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: "use_1",
    memberId: "mem_1",
    modelId: "gpt-6-luna",
    at: "2026-10-07T08:00:00.000Z",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 1,
    requestId: "gw_1",
    ...overrides,
  };
}

function policy(): TeamPolicy {
  return defaultTeamPolicy("team_1", new Date("2026-10-07T08:00:00.000Z"));
}

test("spend rows become usage rows for known keys only, once per request id", () => {
  const members = new Map([
    [HASH_LENA, member("mem_1", HASH_LENA, "Lena")],
    [HASH_OMAR, member("mem_2", HASH_OMAR, "Omar")],
  ]);
  const rows = toUsageRows(
    [
      spendRow(),
      spendRow(), // duplicate request id
      spendRow({ requestId: "gw_2", keyHash: HASH_OMAR, model: "flagship" }),
      spendRow({ requestId: "gw_3", keyHash: "c".repeat(64) }), // unknown key
    ],
    members,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "use_gw_1",
    memberId: "mem_1",
    modelId: "gpt-6-luna",
    at: "2026-10-07T08:00:01.000Z",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 1,
    requestId: "gw_1",
  });
  assert.equal(rows[1]?.memberId, "mem_2");
  assert.equal(rows[1]?.modelId, "flagship");
});

test("an unfinished gateway row uses its start time", () => {
  const rows = toUsageRows(
    [spendRow({ endedAt: null })],
    new Map([[HASH_LENA, member("mem_1", HASH_LENA, "Lena")]]),
  );
  assert.equal(rows[0]?.at, "2026-10-07T08:00:00.000Z");
});

test("the gateway API format is carried into the usage row when it is known", () => {
  const rows = toUsageRows(
    [
      spendRow({ requestId: "gw_a", apiFormat: "anthropic_messages" }),
      spendRow({ requestId: "gw_b" }),
    ],
    new Map([[HASH_LENA, member("mem_1", HASH_LENA, "Lena")]]),
  );
  assert.equal(rows[0]?.apiFormat, "anthropic_messages");
  assert.equal(rows[1]?.apiFormat, undefined, "no format stays absent, not guessed");
});

test("aggregates group by member, model and local day and separate off-hours cost", () => {
  const rows = [
    usageRow({ id: "u1", at: "2026-10-07T08:00:00.000Z", costUsd: 1 }), // 10:00 local
    usageRow({ id: "u2", at: "2026-10-07T17:30:00.000Z", costUsd: 2 }), // 19:30 local
    usageRow({ id: "u3", modelId: "flagship", at: "2026-10-07T09:00:00.000Z", costUsd: 3 }),
    usageRow({ id: "u4", at: "2026-10-08T08:00:00.000Z", costUsd: 4 }), // next local day
  ];
  const aggregates = aggregateUsage(rows, policy(), new Date("2026-10-09T08:00:00.000Z"));
  assert.equal(aggregates.length, 3);

  const working = aggregates.find(
    (row) => row.day === "2026-10-07" && row.modelId === "gpt-6-luna",
  );
  assert.ok(working !== undefined);
  assert.equal(working.requests, 2);
  assert.equal(working.costUsd, 3);
  assert.equal(working.offHoursCostUsd, 2);
  assert.equal(working.totalTokens, 300);

  const flagship = aggregates.find((row) => row.modelId === "flagship");
  assert.equal(flagship?.offHoursCostUsd, 0);
  assert.equal(aggregates[2]?.day, "2026-10-08");
});

test("daily totals key on the team's local day", () => {
  const rows = [
    usageRow({ id: "u1", at: "2026-10-07T22:30:00.000Z", costUsd: 1 }), // 00:30 on the 8th in Berlin
    usageRow({ id: "u2", at: "2026-10-07T10:00:00.000Z", costUsd: 2 }),
  ];
  const totals = dailyTotals(rows, policy(), new Date("2026-10-09T08:00:00.000Z"));
  assert.equal(totals.get("mem_1")?.get("2026-10-08"), 1);
  assert.equal(totals.get("mem_1")?.get("2026-10-07"), 2);
});

test("a usage snapshot carries period, today, 14-day history and off-hours spend", () => {
  const now = new Date("2026-10-09T18:30:00.000Z"); // Friday 20:30 in Berlin
  const rows = [
    usageRow({ id: "u1", at: "2026-09-28T10:00:00.000Z", costUsd: 0.5 }),
    usageRow({ id: "u2", at: "2026-09-29T10:00:00.000Z", costUsd: 0.7 }),
    usageRow({ id: "u3", at: "2026-10-09T16:00:00.000Z", costUsd: 1 }), // 18:00, in hours
    usageRow({ id: "u4", at: "2026-10-09T17:15:00.000Z", costUsd: 2 }), // 19:15, off-hours
  ];
  const snapshot = usageSnapshot({
    rows,
    policy: policy(),
    limits: { budgetUsd: 10, period: "daily", tokenCap: null, rpm: null, tpm: null },
    now,
  });
  assert.equal(snapshot.periodStartIso, "2026-10-09T00:00:00.000Z");
  assert.equal(snapshot.periodEndIso, "2026-10-10T00:00:00.000Z");
  assert.equal(snapshot.periodSpendUsd, 3);
  assert.equal(snapshot.periodTokens, 300);
  assert.equal(snapshot.todayKey, "2026-10-09");
  assert.equal(snapshot.todaySpendUsd, 3);
  assert.equal(snapshot.offHoursSpendUsd, 2);
  assert.equal(snapshot.offHoursSegmentStartIso, "2026-10-09T17:00:00.000Z");
  assert.equal(snapshot.previousDailyUsd.length, 14);
  assert.equal(snapshot.previousDailyUsd[3], 0.5);
  assert.equal(snapshot.previousDailyUsd[4], 0.7);
  assert.equal(
    snapshot.previousDailyUsd
      .filter((_value, index) => index !== 3 && index !== 4)
      .every((value) => value === 0),
    true,
  );
});

test("rows after now are ignored", () => {
  const now = new Date("2026-10-09T10:00:00.000Z");
  const snapshot = usageSnapshot({
    rows: [usageRow({ id: "u1", at: "2026-10-09T11:00:00.000Z", costUsd: 5 })],
    policy: policy(),
    limits: { budgetUsd: 10, period: "daily", tokenCap: null, rpm: null, tpm: null },
    now,
  });
  assert.equal(snapshot.periodSpendUsd, 0);
  assert.equal(snapshot.todaySpendUsd, 0);
});
