/**
 * Cross-role and cross-team refusals.
 *
 * These are the two escalation paths the plan names: a member credential on a
 * manager route, and a manager acting on a team that is not theirs.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRETS } from "./fixtures.ts";
import {
  bodyOf,
  loginWithMemberKey,
  loginWithPassword,
  startTestServer,
  type TestServer,
} from "./harness.ts";

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("a manager from another team cannot read a member", async () => {
  const client = server.client();
  const response = await client.request("GET", "/api/team/members/mem-1", {
    bearer: server.fixture.otherManagerToken,
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "A manager cannot act on another team.");
});

test("a manager from another team cannot change limits", async () => {
  const client = server.client();
  const response = await client.request("PATCH", "/api/team/members/mem-1/limits", {
    bearer: server.fixture.otherManagerToken,
    body: { budgetUsd: 500 },
  });
  assert.equal(response.status, 403);
});

test("a manager from another team cannot decide a request", async () => {
  const client = server.client();
  const response = await client.request(
    "POST",
    `/api/team/requests/${server.fixture.requestIds.platform}/decide`,
    {
      bearer: server.fixture.otherManagerToken,
      body: { outcome: "approved" },
    },
  );
  assert.equal(response.status, 403);
});

test("a manager from another team cannot edit a rule", async () => {
  const client = server.client();
  const response = await client.request("PUT", "/api/team/rules/rule-platform", {
    bearer: server.fixture.otherManagerToken,
    body: {
      name: "Hijacked",
      enabled: true,
      condition: { kind: "budget_topup", maxUsd: 100, oncePerDays: 1 },
    },
  });
  assert.equal(response.status, 403);
});

test("a manager from another team cannot rotate a key", async () => {
  const client = server.client();
  const response = await client.request("POST", "/api/team/members/mem-1/key/rotate", {
    bearer: server.fixture.otherManagerToken,
  });
  assert.equal(response.status, 403);
});

test("a manager from another team cannot list another team's requests", async () => {
  const client = server.client();
  const response = await client.request("GET", "/api/team/requests?memberId=mem-1", {
    bearer: server.fixture.otherManagerToken,
  });
  assert.equal(response.status, 403);
});

test("a manager cannot select another team with ?teamId=", async () => {
  const client = server.client();
  const response = await client.request("GET", "/api/team/overview?teamId=team-data", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(response.status, 403);
});

test("an admin may act across teams", async () => {
  const client = server.client();
  const member = await client.request("GET", "/api/team/members/mem-2", {
    bearer: server.fixture.adminToken,
  });
  assert.equal(member.status, 200);
  const detail = bodyOf<{ member: { teamId: string; displayName: string } }>(member);
  assert.equal(detail.member.teamId, "team-data");
  assert.equal(detail.member.displayName, "Omar");

  const overview = await client.request("GET", "/api/team/overview?teamId=team-data", {
    bearer: server.fixture.adminToken,
  });
  assert.equal(overview.status, 200);
  const team = bodyOf<{ team: { id: string } }>(overview);
  assert.equal(team.team.id, "team-data");
});

test("a manager session is still refused on another team's member", async () => {
  const client = server.client();
  // Sign in as the platform manager, then ask for the data team's member.
  const login = await loginWithPassword(client, SECRETS.managerEmail, SECRETS.managerPassword);
  assert.equal(login.status, 200);
  const response = await client.request("GET", "/api/team/members/mem-2");
  assert.equal(response.status, 403);
});

test("the manager account's own gateway key is a member credential", async () => {
  const client = server.client();
  const response = await client.request("GET", "/api/team/overview", {
    bearer: SECRETS.managerKey,
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "A member key cannot call a manager route.");
});

test("a member session cannot call a manager route", async () => {
  const client = server.client();
  const login = await loginWithMemberKey(client, SECRETS.memberKey);
  assert.equal(login.status, 200);
  const response = await client.request("GET", "/api/team/overview");
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "A member cannot call a manager route.");
});

test("a member cannot read another member's detail through the member routes", async () => {
  const client = server.client();
  const response = await client.request("GET", "/api/me/requests", {
    bearer: SECRETS.memberKeyTwo,
  });
  assert.equal(response.status, 200);
  const requests = bodyOf<Array<{ memberId: string }>>(response);
  assert.ok(requests.every((request) => request.memberId === "mem-2"));
});
