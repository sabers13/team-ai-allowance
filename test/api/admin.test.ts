/**
 * Admin enrolment: manager accounts, passwords and API tokens.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bodyOf, loginWithPassword, startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("an admin enrolls a manager who can then sign in and act on the team", async () => {
  const email = "rowan@example.com";
  const password = "rowan-pass-01";
  const created = await server.client().request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: { displayName: "Rowan", role: "manager", email, password },
  });
  assert.equal(created.status, 201);
  const body = bodyOf<{ member: { id: string; role: string }; secret: string }>(created);
  assert.equal(body.member.role, "manager");
  assert.match(body.secret, /^taa_member_generated_/);
  assert.equal(JSON.stringify(body.member).includes(password), false);

  const client = server.client();
  const login = await loginWithPassword(client, email, password);
  assert.equal(login.status, 200);
  const session = bodyOf<{ user: { role: string } }>(login);
  assert.equal(session.user.role, "manager");

  const overview = await client.request("GET", "/api/team/overview");
  assert.equal(overview.status, 200);
  const otherTeam = await client.request("GET", "/api/team/members/mem-2");
  assert.equal(otherTeam.status, 403);
});

test("a manager account needs both an email and a password", async () => {
  const client = server.client();
  const noPassword = await client.request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: { displayName: "Casey", role: "manager", email: "casey@example.com" },
  });
  assert.equal(noPassword.status, 400);
  const noEmail = await client.request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: { displayName: "Casey", role: "manager", password: "casey-pass-01" },
  });
  assert.equal(noEmail.status, 400);
  const tooShort = await client.request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: { displayName: "Casey", role: "manager", email: "casey@example.com", password: "short" },
  });
  assert.equal(tooShort.status, 400);
});

test("a member cannot be given a password", async () => {
  const response = await server.client().request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: {
      displayName: "Sam",
      role: "member",
      email: "sam@example.com",
      password: "sam-pass-001",
    },
  });
  assert.equal(response.status, 400);
});

test("a manager token cannot be minted for a plain member", async () => {
  const response = await server.client().request("POST", "/api/admin/manager-tokens", {
    bearer: server.fixture.adminToken,
    body: { memberId: "mem-1" },
  });
  assert.equal(response.status, 400);
});

test("a config bundle for a member of another team under a wrong team path is a 404", async () => {
  const response = await server
    .client()
    .request("GET", "/api/admin/teams/team-platform/members/mem-2/config-bundle", {
      bearer: server.fixture.adminToken,
    });
  assert.equal(response.status, 404);
});

test("a minted manager token works immediately", async () => {
  const created = await server.client().request("POST", "/api/admin/manager-tokens", {
    bearer: server.fixture.adminToken,
    body: { memberId: "mgr-2", label: "night shift" },
  });
  assert.equal(created.status, 201);
  const token = bodyOf<{ token: string }>(created).token;
  const overview = await server.client().request("GET", "/api/team/overview", { bearer: token });
  assert.equal(overview.status, 200);
  const team = bodyOf<{ team: { id: string } }>(overview);
  assert.equal(team.team.id, "team-data");
});

test("minting a manager token writes an audit row that names the actor but no token", async () => {
  const before = server.fixture.store.audit.length;
  const created = await server.client().request("POST", "/api/admin/manager-tokens", {
    bearer: server.fixture.adminToken,
    body: { memberId: "mgr-1", label: "audited" },
  });
  assert.equal(created.status, 201);
  const body = bodyOf<{ id: string; token: string }>(created);
  const events = server.fixture.store.audit.slice(before).map((row) => row.event);
  const event = events.find((entry) => entry.action === "manager_token.issued");
  assert.ok(event);
  assert.equal(event.objectId, body.id);
  assert.equal(event.actor.id, server.fixture.memberIds.admin);
  const payload = JSON.stringify(event.after);
  assert.equal(payload.includes(body.token), false);
  assert.equal(payload.includes("tokenHash"), false);
});
