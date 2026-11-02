/**
 * Contract tests for the LiteLLM client, against the recorded admin API fake.
 *
 * These assert the LiteLLM open-source admin wire contract: paths,
 * bodies, the hash-only key handling and the spend mapping.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { LiteLLMGatewayClient } from "../../src/gateway/index.ts";
import { type FakeAdmin, routeTable, startFakeAdmin } from "./fake-admin.ts";

interface Fixture {
  readonly keyGenerate: Record<string, unknown>;
  readonly keyList: Record<string, unknown>;
  readonly keyInfo: Record<string, unknown>;
  readonly teamNew: Record<string, unknown>;
  readonly teamInfo: Record<string, unknown>;
  readonly teamList: Record<string, unknown>;
  readonly userNew: Record<string, unknown>;
  readonly userInfo: Record<string, unknown>;
  readonly userList: Record<string, unknown>;
  readonly spendLogs: unknown[];
  readonly teamSpend: Record<string, unknown>;
  readonly errors: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/admin-responses.json", import.meta.url), "utf8"),
) as Fixture;

const MASTER_KEY = "sk-test-master";
const SECRET = "sk-recorded-123";
const KEY_HASH = createHash("sha256").update(SECRET).digest("hex");
const RECORDED_KEY_HASH = "3f4a1c2d5e6b7a8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e";

let fake: FakeAdmin;
let client: LiteLLMGatewayClient;

before(async () => {
  fake = await startFakeAdmin(
    routeTable({
      "/key/generate": fixture.keyGenerate,
      "/key/list": fixture.keyList,
      "/key/info": fixture.keyInfo,
      "/key/update": {},
      "/key/delete": {},
      "/key/block": {},
      "/key/unblock": {},
      "/team/new": fixture.teamNew,
      "/team/update": {},
      "/team/delete": {},
      "/team/info": fixture.teamInfo,
      "/team/list": fixture.teamList,
      "/team/member_add": {},
      "/team/member_update": {},
      "/team/member_delete": {},
      "/team/spend/by_user": fixture.teamSpend,
      "/team/block": {},
      "/team/unblock": {},
      "/user/new": fixture.userNew,
      "/user/update": {},
      "/user/delete": {},
      "/user/info": fixture.userInfo,
      "/user/list": fixture.userList,
      "/spend/logs": fixture.spendLogs,
      "/health/liveliness": { ok: true },
    }),
  );
  client = new LiteLLMGatewayClient({ baseUrl: fake.url, masterKey: MASTER_KEY });
});

after(async () => {
  await fake.close();
});

function lastCall() {
  const call = fake.calls.at(-1);
  assert.ok(call !== undefined, "no request was recorded");
  return call;
}

test("createKey posts the frozen input and returns a hash, not the secret", async () => {
  const created = await client.createKey({
    keyAlias: "taa-m1",
    teamId: "team-1",
    userId: "user-1",
    models: ["mock-cheap"],
    maxBudgetUsd: 1,
    budgetDuration: "1d",
    tpmLimit: 60_000,
    rpmLimit: 60,
  });

  const call = lastCall();
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/key/generate");
  assert.equal(call.headers.authorization, `Bearer ${MASTER_KEY}`);
  assert.deepEqual(call.body, {
    key_alias: "taa-m1",
    models: ["mock-cheap"],
    max_budget: 1,
    budget_duration: "1d",
    tpm_limit: 60_000,
    rpm_limit: 60,
    team_id: "team-1",
    user_id: "user-1",
  });
  assert.equal(created.secret, SECRET);
  assert.equal(created.keyHash, KEY_HASH);
  assert.equal(created.keyAlias, "taa-m1");
});

test("updateKey sends the desired key state and address the alias", async () => {
  await client.updateKey(
    { keyAlias: "taa-m1", keyHash: KEY_HASH },
    {
      keyAlias: "taa-m1",
      models: ["mock-cheap", "mock-flagship"],
      maxBudgetUsd: 2.5,
      budgetDuration: "7d",
      tpmLimit: null,
      rpmLimit: 120,
      blocked: true,
    },
  );

  const call = lastCall();
  assert.equal(call.path, "/key/update");
  assert.deepEqual(call.body, {
    key_alias: "taa-m1",
    models: ["mock-cheap", "mock-flagship"],
    max_budget: 2.5,
    budget_duration: "7d",
    tpm_limit: null,
    rpm_limit: 120,
    blocked: true,
  });
});

test("block and unblock send the hash, never a secret", async () => {
  const ref = { keyAlias: "taa-m1", keyHash: KEY_HASH };
  await client.blockKey(ref);
  assert.equal(lastCall().path, "/key/block");
  assert.deepEqual(lastCall().body, { key: KEY_HASH });
  assert.equal(lastCall().headers.authorization, `Bearer ${MASTER_KEY}`);

  await client.unblockKey(ref);
  assert.equal(lastCall().path, "/key/unblock");
  assert.deepEqual(lastCall().body, { key: KEY_HASH });
});

test("deleteKey uses the alias so no secret is needed", async () => {
  await client.deleteKey({ keyAlias: "taa-m1", keyHash: KEY_HASH });
  assert.equal(lastCall().path, "/key/delete");
  assert.deepEqual(lastCall().body, { key_aliases: ["taa-m1"] });
});

test("getKeyInfo reads the hash and parses string numbers", async () => {
  const info = await client.getKeyInfo({ keyAlias: "taa-m1", keyHash: KEY_HASH });
  const call = lastCall();
  assert.equal(call.path, "/key/info");
  assert.equal(call.query.key, KEY_HASH);
  assert.ok(info !== null);
  assert.equal(info.spendUsd, 0.000026);
  assert.equal(info.maxBudgetUsd, 1);
  assert.equal(info.tpmLimit, 60_000);
  assert.equal(info.rpmLimit, 60);
  assert.equal(info.budgetDuration, "1d");
});

test("regenerateKey reads the alias, then replaces the key", async () => {
  const before = fake.calls.length;
  const rotated = await client.regenerateKey({ keyAlias: "taa-m1", keyHash: KEY_HASH });
  const calls = fake.calls.slice(before);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/key/list", "/key/delete", "/key/generate"],
    "rotation must not call the Enterprise-gated /key/regenerate",
  );
  assert.equal(calls[0]?.query.key_alias, "taa-m1");
  assert.deepEqual(calls[2]?.body, {
    key_alias: "taa-m1",
    models: ["mock-cheap"],
    max_budget: 1,
    budget_duration: "1d",
    tpm_limit: 60_000,
    rpm_limit: 60,
    team_id: "team-1",
    user_id: "user-1",
  });
  assert.equal(rotated.secret, SECRET);
  assert.equal(rotated.keyHash, KEY_HASH);
});

test("team helpers use the team routes", async () => {
  assert.equal(
    await client.createTeam({ name: "Platform", monthlyBudgetUsd: 10, modelIds: ["mock-cheap"] }),
    "team-1",
  );
  assert.equal(lastCall().path, "/team/new");
  assert.deepEqual(lastCall().body, {
    team_alias: "Platform",
    max_budget: 10,
    models: ["mock-cheap"],
  });

  await client.updateTeam("team-1", { name: "Platform 2", monthlyBudgetUsd: 20 });
  assert.deepEqual(lastCall().body, {
    team_id: "team-1",
    team_alias: "Platform 2",
    max_budget: 20,
  });

  await client.deleteTeam("team-1");
  assert.deepEqual(lastCall().body, { team_ids: ["team-1"] });

  await client.addTeamMember("team-1", "user-1", "member");
  assert.deepEqual(lastCall().body, {
    team_id: "team-1",
    member: { user_id: "user-1", role: "user" },
  });

  await client.addTeamMember("team-1", "user-2", "manager");
  assert.deepEqual(lastCall().body, {
    team_id: "team-1",
    member: { user_id: "user-2", role: "admin" },
  });

  await client.updateTeamMember("team-1", "user-1", {
    maxBudgetInTeamUsd: 2,
    budgetDuration: "7d",
    tpmLimit: 1000,
    rpmLimit: 10,
  });
  assert.deepEqual(lastCall().body, {
    team_id: "team-1",
    user_id: "user-1",
    max_budget_in_team: 2,
    budget_duration: "7d",
    tpm_limit: 1000,
    rpm_limit: 10,
  });

  await client.removeTeamMember("team-1", "user-1");
  assert.deepEqual(lastCall().body, { team_id: "team-1", user_id: "user-1" });

  const team = await client.getTeamInfo("team-1");
  assert.ok(team !== null);
  assert.equal(team.spendUsd, 0.25);

  await client.blockTeam("team-1");
  assert.deepEqual(lastCall().body, { team_id: "team-1" });
  await client.unblockTeam("team-1");
  assert.deepEqual(lastCall().body, { team_id: "team-1" });

  const teams = await client.listTeams();
  assert.equal(teams.length, 1);
  assert.equal(teams[0]?.teamAlias, "Platform");
});

test("user helpers use the user routes and never create a second key", async () => {
  assert.equal(await client.createUser({ userId: "user-1", userAlias: "Lena" }), "user-1");
  assert.equal(lastCall().path, "/user/new");
  assert.deepEqual(lastCall().body, {
    user_id: "user-1",
    auto_create_key: false,
    user_alias: "Lena",
  });

  await client.updateUser("user-1", { userAlias: "Lena B", maxBudgetUsd: 5 });
  assert.deepEqual(lastCall().body, {
    user_id: "user-1",
    user_alias: "Lena B",
    max_budget: 5,
  });

  const user = await client.getUserInfo("user-1");
  assert.ok(user !== null);
  assert.deepEqual(user.teams, ["team-1"]);

  await client.deleteUser("user-1");
  assert.deepEqual(lastCall().body, { user_ids: ["user-1"] });

  const users = await client.listUsers();
  assert.equal(users.length, 1);
});

test("listSpend sends the date window and maps every field", async () => {
  const rows = await client.listSpend({
    from: "2026-10-31T08:00:00Z",
    to: "2026-10-31T10:00:00Z",
    teamId: "team-1",
  });
  const call = lastCall();
  assert.equal(call.path, "/spend/logs");
  assert.equal(call.query.start_date, "2026-10-31", "the endpoint parses dates, not timestamps");
  assert.equal(call.query.end_date, "2026-11-01");
  assert.equal(call.query.summarize, "false");

  assert.equal(rows.length, 1, "the team filter is applied client-side");
  const row = rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.requestId, "req-1");
  assert.equal(row.keyHash, RECORDED_KEY_HASH);
  assert.equal(row.teamId, "team-1");
  assert.equal(row.model, "mock-cheap");
  assert.equal(row.spendUsd, 0.000026);
  assert.equal(row.totalTokens, 19);
  assert.equal(row.startedAt, "2026-10-31T09:00:00Z");
  assert.equal(row.apiFormat, "chat_completions");
  assert.ok(!("messages" in row), "a spend row never carries prompt text");
});

test("teamSpendByUser parses string spends", async () => {
  const rows = await client.teamSpendByUser("team-1");
  assert.equal(lastCall().path, "/team/spend/by_user");
  assert.deepEqual(rows, [
    { userId: "user-1", spendUsd: 0.000026 },
    { userId: "user-2", spendUsd: 0.000039 },
  ]);
});

test("healthy() is true on a live gateway", async () => {
  assert.equal(await client.healthy(), true);
  assert.equal(lastCall().path, "/health/liveliness");
});
