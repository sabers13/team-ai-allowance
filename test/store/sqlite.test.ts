import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  AuditEvent,
  Grant,
  Limits,
  Request,
  TeamPolicy,
  UsageRow,
} from "../../src/contracts.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { defaultTeamPolicy } from "../../src/core/policy.ts";
import {
  openSqliteStore,
  resolveDbPath,
  SCHEMA_VERSION,
  type SqliteStore,
} from "../../src/store/index.ts";

const NOW = "2026-10-05T09:00:00.000Z";

const limits: Limits = { budgetUsd: 20, period: "daily", tokenCap: null, rpm: null, tpm: null };

function grants(): Grant {
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
    startsAt: "2026-10-05T09:00:00.000Z",
    expiresAt: "2026-10-06T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-10-05T09:00:00.000Z",
  };
}

function request(): Request {
  return {
    id: "req_1",
    memberId: "mem_1",
    teamId: "team_1",
    kind: "more_budget",
    amountUsd: 5,
    modelId: null,
    message: "please",
    state: "pending",
    context: { spendThisPeriodUsd: 1, limitUsd: 20, topModels: [], last7DaysUsd: 3 },
    createdAt: NOW,
    expiresAt: "2026-10-08T09:00:00.000Z",
    decidedAt: null,
  };
}

function usageRow(id: string, requestId: string, memberId: string, at = NOW, cost = 1): UsageRow {
  return {
    id,
    memberId,
    modelId: "luna",
    at,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: cost,
    requestId,
  };
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "aud_1",
    at: NOW,
    actor: { type: "manager", id: "user_priya", displayName: "Priya" },
    action: "request.decided",
    objectType: "request",
    objectId: "req_1",
    before: { id: "req_1", state: "pending", teamId: "team_1" },
    after: { id: "req_1", state: "approved", teamId: "team_1" },
    reason: "ok",
    ...overrides,
  };
}

interface TempStore {
  store: SqliteStore;
  path: string;
  dir: string;
  cleanup(): void;
}

function tempStore(clock = new ManualClock(NOW)): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "taa-store-"));
  const path = join(dir, "taa.db");
  const store = openSqliteStore({ path, clock });
  return {
    store,
    path,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedMember(store: SqliteStore) {
  const team = await store.createTeam({ name: "Platform", monthlyBudgetUsd: 500 });
  const member = await store.createMember({
    teamId: team.id,
    displayName: "Lena",
    email: null,
    role: "member",
    keyAlias: "taa-mem_1",
    keyHash: "hash-lena",
    blocked: false,
    blockedReason: null,
  });
  await store.setLimits(member.id, limits);
  return { team, member };
}

test("a limits audit event is scoped to the member's team", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { team, member } = await seedMember(store);
    await store.appendAudit(
      auditEvent({
        id: "aud_limits",
        action: "limits.updated",
        objectType: "limits",
        objectId: member.id,
        before: limits,
        after: { ...limits, budgetUsd: 30 },
        reason: null,
      }),
    );
    const rows = await store.listAudit({ teamId: team.id });
    assert.deepEqual(
      rows.map((event) => event.id),
      ["aud_limits"],
    );
  } finally {
    temp.cleanup();
  }
});

test("open runs every migration once and records the version", async () => {
  const temp = tempStore();
  try {
    assert.equal(temp.store.schemaVersion(), SCHEMA_VERSION);
    temp.store.close();
    const reopened = openSqliteStore({ path: temp.path });
    try {
      assert.equal(reopened.schemaVersion(), SCHEMA_VERSION);
      const raw = new DatabaseSync(temp.path);
      try {
        const rows = raw
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as unknown as Array<{ version: number }>;
        assert.deepEqual(
          rows.map((row) => row.version),
          [1, 2, 3, 4, 5],
        );
      } finally {
        raw.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("TAA_DB_PATH is the store's only environment input", () => {
  assert.ok(resolveDbPath({}).endsWith("/var/taa.db"));
  assert.ok(resolveDbPath({ TAA_DB_PATH: "/tmp/taa-test.db" }).endsWith("/tmp/taa-test.db"));
});

test("team CRUD and cascade delete", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const team = await store.createTeam({ name: "Platform", monthlyBudgetUsd: 500 });
    assert.match(team.id, /^team_/);
    assert.equal((await store.getTeam(team.id))?.name, "Platform");
    const renamed = await store.updateTeam(team.id, { name: "Platform 2", monthlyBudgetUsd: 600 });
    assert.equal(renamed.name, "Platform 2");
    assert.equal((await store.listTeams()).length, 1);

    const member = await store.createMember({
      teamId: team.id,
      displayName: "Lena",
      email: null,
      role: "member",
      keyAlias: "taa-mem_1",
      keyHash: "hash-lena",
      blocked: false,
      blockedReason: null,
    });
    await store.deleteTeam(team.id);
    assert.equal(await store.getTeam(team.id), null);
    assert.equal(await store.getMember(member.id), null);
  } finally {
    temp.cleanup();
  }
});

test("member CRUD, key hash lookup and model selection", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { member } = await seedMember(store);
    assert.equal((await store.getMemberByKeyHash("hash-lena"))?.id, member.id);
    assert.equal(await store.getMemberByKeyHash("no-such-hash"), null);
    assert.equal((await store.listMembers(member.teamId)).length, 1);

    const updated = await store.updateMember(member.id, {
      blocked: true,
      blockedReason: "off-hours",
    });
    assert.equal(updated.blocked, true);
    assert.equal(updated.blockedReason, "off-hours");

    assert.deepEqual(await store.getMemberModels(member.id), []);
    assert.deepEqual(await store.setMemberModels(member.id, ["luna", "flash", "luna"], NOW), [
      "flash",
      "luna",
    ]);
    assert.deepEqual(await store.getMemberModels(member.id), ["flash", "luna"]);

    const limitsRow = await store.getLimits(member.id);
    assert.deepEqual(limitsRow, limits);
    await store.setLimits(member.id, { ...limits, budgetUsd: 30, period: "weekly" });
    assert.equal((await store.getLimits(member.id))?.budgetUsd, 30);

    await store.deleteMember(member.id);
    assert.equal(await store.getMember(member.id), null);
    assert.equal(await store.getLimits(member.id), null);
  } finally {
    temp.cleanup();
  }
});

test("the model catalogue keeps insertion order and updates in place", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    await store.upsertModel({
      id: "luna",
      displayName: "Luna",
      route: "mock/luna",
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      state: "enabled",
      sortOrder: 2,
    });
    await store.upsertModel({
      id: "flash",
      displayName: "Flash",
      route: "mock/flash",
      inputPer1MUsd: 1,
      outputPer1MUsd: 1,
      state: "approval-required",
      sortOrder: 1,
    });
    assert.deepEqual(
      (await store.listModels()).map((model) => model.id),
      ["flash", "luna"],
    );
    await store.upsertModel({
      id: "luna",
      displayName: "Luna",
      route: "mock/luna",
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      state: "blocked",
      sortOrder: 2,
    });
    assert.equal((await store.listModels()).find((model) => model.id === "luna")?.state, "blocked");
    await store.deleteModel("luna");
    assert.deepEqual(
      (await store.listModels()).map((model) => model.id),
      ["flash"],
    );
  } finally {
    temp.cleanup();
  }
});

test("grants list active-only at an instant and track expiry once", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { member } = await seedMember(store);
    await store.addGrant({ ...grants(), memberId: member.id, requestId: null });
    assert.equal((await store.listGrants(member.id)).length, 1);
    assert.equal((await store.listGrants(member.id, NOW)).length, 1);
    assert.equal((await store.listGrants(member.id, "2026-10-06T00:00:00.000Z")).length, 0);

    const expired = await store.listExpiredGrants("2026-10-06T00:00:00.000Z");
    assert.deepEqual(
      expired.map((grant) => grant.id),
      ["grn_1"],
    );

    await store.revokeGrant("grn_1", "2026-10-05T10:00:00.000Z");
    assert.equal((await store.listExpiredGrants("2026-10-06T00:00:00.000Z")).length, 0);
    assert.equal((await store.listGrants(member.id, "2026-10-05T10:00:00.000Z")).length, 0);

    await store.markGrantExpired("grn_1", "2026-10-06T00:00:00.000Z");
    await store.markGrantExpired("grn_1", "2026-10-06T00:00:00.000Z");
  } finally {
    temp.cleanup();
  }
});

test("requests list filters, state transitions and decisions", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { team, member } = await seedMember(store);
    await store.createRequest({ ...request(), memberId: member.id, teamId: team.id });
    await store.createRequest({
      ...request(),
      id: "req_2",
      memberId: member.id,
      teamId: team.id,
      state: "approved",
      createdAt: "2026-10-05T10:00:00.000Z",
      expiresAt: "2026-10-08T10:00:00.000Z",
    });
    assert.equal((await store.listRequests({ state: "pending" })).length, 1);
    assert.equal((await store.listRequests({ teamId: team.id })).length, 2);
    assert.equal((await store.listRequests({ teamId: team.id, limit: 1 })).length, 1);

    const approved = await store.setRequestState("req_2", "denied", "2026-10-05T11:00:00.000Z");
    assert.equal(approved.state, "denied");
    assert.equal(approved.decidedAt, "2026-10-05T11:00:00.000Z");
    const expired = await store.setRequestState("req_1", "expired", "2026-10-05T11:00:00.000Z");
    assert.equal(expired.decidedAt, null);

    const decision = {
      id: "dec_1",
      requestId: "req_2",
      outcome: "denied" as const,
      decidedById: "user_priya",
      decidedByRole: "manager" as const,
      note: "no",
      grantedAmountUsd: null,
      grantedModelId: null,
      grantExpiresAt: null,
      grantId: null,
      source: "manager" as const,
      decidedAt: "2026-10-05T11:00:00.000Z",
    };
    await store.addDecision(decision);
    assert.deepEqual(await store.listDecisions("req_2"), [decision]);
    assert.deepEqual(await store.listDecisions("req_1"), []);
  } finally {
    temp.cleanup();
  }
});

test("rules and the team policy round-trip", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { team } = await seedMember(store);
    const rule = {
      id: "rule_1",
      teamId: team.id,
      name: "top-up",
      enabled: true,
      condition: { kind: "budget_topup" as const, maxUsd: 10, oncePerDays: 7 },
      createdAt: NOW,
    };
    await store.upsertRule(rule);
    assert.deepEqual(await store.listRules(team.id), [rule]);
    await store.upsertRule({
      ...rule,
      enabled: false,
      condition: { kind: "model_unlock", modelIds: ["flagship"], durationHours: 2 },
    });
    const updated = (await store.listRules(team.id))[0];
    assert.equal(updated?.enabled, false);
    assert.deepEqual(updated?.condition, {
      kind: "model_unlock",
      modelIds: ["flagship"],
      durationHours: 2,
    });
    await store.deleteRule("rule_1");
    assert.deepEqual(await store.listRules(team.id), []);

    const policy: TeamPolicy = { ...defaultTeamPolicy(team.id, new Date(NOW)), updatedAt: NOW };
    await store.setTeamPolicy(policy);
    assert.deepEqual(await store.getTeamPolicy(team.id), policy);
  } finally {
    temp.cleanup();
  }
});

test("usage rows de-duplicate by request id and filter by member, team and model", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    const { team, member } = await seedMember(store);
    await store.recordUsage([
      { ...usageRow("use_1", "gw_1", member.id, NOW, 1), apiFormat: "responses" },
    ]);
    await store.recordUsage([
      usageRow("use_2", "gw_1", member.id, NOW, 99),
      usageRow("use_3", "gw_2", member.id, "2026-10-05T10:00:00.000Z", 2),
    ]);
    const all = await store.listUsage({ from: NOW, to: "2026-10-05T23:00:00.000Z" });
    assert.equal(all.length, 2);
    assert.equal(all[0]?.apiFormat, "responses");
    assert.equal(all[1]?.apiFormat, undefined);
    assert.equal(
      all.reduce((sum, row) => sum + row.costUsd, 0),
      3,
    );

    assert.equal(
      (await store.listUsage({ memberId: member.id, from: NOW, to: "2026-10-05T23:00:00.000Z" }))
        .length,
      2,
    );
    assert.equal(
      (await store.listUsage({ teamId: team.id, from: NOW, to: "2026-10-05T23:00:00.000Z" }))
        .length,
      2,
    );
    assert.equal(
      (await store.listUsage({ modelId: "other", from: NOW, to: "2026-10-05T23:00:00.000Z" }))
        .length,
      0,
    );
    assert.equal(
      (await store.listUsage({ from: "2026-10-05T09:30:00.000Z", to: "2026-10-05T23:00:00.000Z" }))
        .length,
      1,
    );
  } finally {
    temp.cleanup();
  }
});

test("an audit payload keeps its team scope and never stores a key hash", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    await store.appendAudit(
      auditEvent({
        id: "aud_notice",
        action: "notification.sent",
        objectType: "notification",
        objectId: "request_created:req_1",
        before: null,
        after: { kind: "request_created", teamId: "team_notify", memberId: "mem_1" },
        reason: "request_created",
      }),
    );
    await store.appendAudit(
      auditEvent({
        id: "aud_block",
        action: "member.blocked",
        objectType: "member",
        objectId: "mem_1",
        before: { id: "mem_1", keyHash: "a".repeat(64) },
        after: { id: "mem_1", keyHash: "a".repeat(64), blocked: true },
        reason: "unusual spend",
      }),
    );
    const notices = await store.listAudit({ teamId: "team_notify" });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.action, "notification.sent");

    const block = (await store.listAudit({ objectType: "member" })).find(
      (event) => event.id === "aud_block",
    );
    assert.ok(block);
    assert.deepEqual(block.after, { id: "mem_1", blocked: true });
    assert.deepEqual(block.before, { id: "mem_1" });
  } finally {
    temp.cleanup();
  }
});

test("the audit log keeps order, filters, before/after and refuses updates", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    await store.appendAudit(auditEvent());
    await store.appendAudit(
      auditEvent({
        id: "aud_2",
        at: "2026-10-05T10:00:00.000Z",
        action: "grant.issued",
        objectType: "grant",
        objectId: "grn_1",
        after: { id: "grn_1", teamId: "team_1" },
        reason: null,
      }),
    );
    await store.appendAudit(
      auditEvent({
        id: "aud_3",
        at: "2026-10-05T11:00:00.000Z",
        action: "request.created",
        actor: { type: "member", id: "mem_1", displayName: "Lena" },
      }),
    );

    const all = await store.listAudit({});
    assert.deepEqual(
      all.map((event) => event.id),
      ["aud_1", "aud_2", "aud_3"],
    );
    assert.deepEqual(all[0]?.before, { id: "req_1", state: "pending", teamId: "team_1" });
    assert.deepEqual(all[0]?.after, { id: "req_1", state: "approved", teamId: "team_1" });
    assert.equal(all[1]?.reason, null);

    assert.deepEqual((await store.listAudit({ teamId: "team_1" })).length, 3);
    assert.deepEqual(
      (await store.listAudit({ actorId: "mem_1" })).map((event) => event.id),
      ["aud_3"],
    );
    assert.deepEqual(
      (await store.listAudit({ objectType: "grant" })).map((event) => event.id),
      ["aud_2"],
    );
    assert.deepEqual(
      (
        await store.listAudit({ from: "2026-10-05T09:30:00.000Z", to: "2026-10-05T10:30:00.000Z" })
      ).map((event) => event.id),
      ["aud_2"],
    );
    assert.deepEqual(
      (await store.listAudit({ limit: 2 })).map((event) => event.id),
      ["aud_2", "aud_3"],
    );

    temp.store.close();
    const raw = new DatabaseSync(temp.path);
    try {
      assert.throws(() => raw.exec("UPDATE audit_events SET reason = 'changed'"), /append-only/);
      assert.throws(() => raw.exec("DELETE FROM audit_events"), /append-only/);
      const count = raw.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as unknown as {
        count: number;
      };
      assert.equal(count.count, 3);
    } finally {
      raw.close();
    }
  } finally {
    try {
      temp.store.close();
    } catch {
      // already closed for the raw-connection check
    }
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("key state is upserted and listed by alias", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    await store.setKeyState(
      {
        keyAlias: "taa-mem_1",
        models: ["luna"],
        maxBudgetUsd: 20,
        budgetDuration: "1d",
        tpmLimit: null,
        rpmLimit: null,
        blocked: false,
      },
      NOW,
    );
    await store.setKeyState(
      {
        keyAlias: "taa-mem_1",
        models: ["flash", "luna"],
        maxBudgetUsd: 25,
        budgetDuration: "7d",
        tpmLimit: 100,
        rpmLimit: 10,
        blocked: true,
      },
      NOW,
    );
    const stored = await store.getKeyState("taa-mem_1");
    assert.deepEqual(stored?.models, ["flash", "luna"]);
    assert.equal(stored?.maxBudgetUsd, 25);
    assert.equal(stored?.blocked, true);
    assert.deepEqual(
      (await store.listKeyStates()).map((state) => state.keyAlias),
      ["taa-mem_1"],
    );
  } finally {
    temp.cleanup();
  }
});

test("transactions commit and roll back, including nested savepoints", async () => {
  const temp = tempStore();
  try {
    const { store } = temp;
    await store.transaction(async () => {
      await store.createTeam({ name: "Committed", monthlyBudgetUsd: 1 });
    });
    assert.equal((await store.listTeams()).length, 1);

    await assert.rejects(
      store.transaction(async () => {
        await store.createTeam({ name: "Rolled back", monthlyBudgetUsd: 1 });
        throw new Error("stop");
      }),
      /stop/,
    );
    assert.deepEqual(
      (await store.listTeams()).map((team) => team.name),
      ["Committed"],
    );

    await store.transaction(async () => {
      await store.createTeam({ name: "Outer", monthlyBudgetUsd: 1 });
      await assert.rejects(
        store.transaction(async () => {
          await store.createTeam({ name: "Inner", monthlyBudgetUsd: 1 });
          throw new Error("inner stop");
        }),
        /inner stop/,
      );
    });
    assert.deepEqual((await store.listTeams()).map((team) => team.name).sort(), [
      "Committed",
      "Outer",
    ]);
  } finally {
    temp.cleanup();
  }
});

test("the schema stores no prompt or response text", async () => {
  const temp = tempStore();
  try {
    const raw = new DatabaseSync(temp.path);
    try {
      const columns = raw
        .prepare("SELECT name FROM pragma_table_info('usage_rows')")
        .all() as unknown as Array<{ name: string }>;
      const names = columns.map((column) => column.name).join(",");
      assert.doesNotMatch(names, /prompt|response|completion|content/i);
      const requestColumns = raw
        .prepare("SELECT name FROM pragma_table_info('requests')")
        .all() as unknown as Array<{ name: string }>;
      assert.deepEqual(requestColumns.map((column) => column.name).includes("message"), true);
    } finally {
      raw.close();
    }
  } finally {
    temp.cleanup();
  }
});
