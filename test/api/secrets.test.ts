/**
 * Secrecy: keys, passwords and tokens appear exactly once, in the response
 * that creates them, and never in a later response, a log line or a bundle.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sha256Hex } from "../../src/auth/index.ts";
import { SECRETS } from "./fixtures.ts";
import { bodyOf, loginWithPassword, startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

interface CreatedMemberBody {
  member: { id: string; displayName: string; role: string; keyHash?: unknown };
  secret: string;
}

test("a new member's key is returned once and stored only as a hash", async () => {
  const client = server.client();
  const response = await client.request("POST", "/api/admin/teams/team-platform/members", {
    bearer: server.fixture.adminToken,
    body: { displayName: "Rae", role: "member" },
  });
  assert.equal(response.status, 201);
  const body = bodyOf<CreatedMemberBody>(response);
  assert.match(body.secret, /^taa_member_generated_/);
  assert.equal("keyHash" in body.member, false);
  assert.equal(JSON.stringify(body.member).includes(body.secret), false);

  const stored = server.fixture.store.members.get(body.member.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.keyHash, sha256Hex(body.secret));
  assert.notEqual(stored.keyHash, body.secret);
});

test("a later member listing has no hash and no secret", async () => {
  const list = await server.client().request("GET", "/api/team/members", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(list.status, 200);
  const text = JSON.stringify(list.body);
  assert.equal(text.includes("keyHash"), false);
  assert.equal(text.includes(SECRETS.memberKey), false);
  assert.equal(text.includes("taa_member_"), false);
});

test("rotating a key returns a new secret once and invalidates the old key", async () => {
  const client = server.client();
  const response = await client.request("POST", "/api/team/members/mem-rot/key/rotate", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(response.status, 200);
  const body = bodyOf<{ member: Record<string, unknown>; secret: string }>(response);
  assert.match(body.secret, /^taa_member_rotated_/);
  assert.equal("keyHash" in body.member, false);

  const oldKey = await server.client().request("GET", "/api/me", {
    bearer: "taa_member_rotatable_0123456789",
  });
  assert.equal(oldKey.status, 401);

  const newKey = await server.client().request("GET", "/api/me", { bearer: body.secret });
  assert.equal(newKey.status, 200);

  const detail = await server.client().request("GET", "/api/team/members/mem-rot", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(JSON.stringify(detail.body).includes(body.secret), false);
});

test("manager passwords are stored as scrypt hashes, never clear", async () => {
  const credential = await server.fixture.credentials.findByMember("mgr-1");
  assert.ok(credential !== null);
  assert.equal(credential.passwordHash.startsWith("scrypt$"), true);
  assert.notEqual(credential.passwordHash, SECRETS.managerPassword);
  assert.equal(credential.passwordHash.includes(SECRETS.managerPassword), false);
});

test("manager API tokens are stored as hashes, never clear", async () => {
  const records = await server.fixture.tokens.list("mgr-1");
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.match(record.tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(record.tokenHash, server.fixture.managerToken);
  }
  assert.equal(
    records.some((record) => record.tokenHash === sha256Hex(server.fixture.managerToken)),
    true,
  );
});

test("a new manager token is shown once", async () => {
  const response = await server.client().request("POST", "/api/admin/manager-tokens", {
    bearer: server.fixture.adminToken,
    body: { memberId: "mgr-1", label: "ci" },
  });
  assert.equal(response.status, 201);
  const body = bodyOf<{ token: string; id: string }>(response);
  assert.match(body.token, /^taa_mgr_/);

  const records = await server.fixture.tokens.list("mgr-1");
  const stored = records.find((record) => record.id === body.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.tokenHash, sha256Hex(body.token));
  assert.equal(JSON.stringify(stored).includes(body.token), false);
});

test("no secret appears in a log line", async () => {
  const loginFailure = await loginWithPassword(
    server.client(),
    SECRETS.managerEmail,
    "log-probe-password-123",
  );
  assert.equal(loginFailure.status, 401);
  await server.client().request("POST", "/api/team/members/mem-rot/key/rotate", {
    bearer: server.fixture.managerToken,
  });
  const text = JSON.stringify(server.logs);
  for (const secret of [
    SECRETS.managerPassword,
    SECRETS.adminPassword,
    SECRETS.memberKey,
    SECRETS.managerKey,
    "taa_member_rotated_",
    "log-probe-password-123",
  ]) {
    assert.equal(text.includes(secret), false, `log contains ${secret}`);
  }
});

test("the enrolment bundle never contains the member key", async () => {
  const response = await server
    .client()
    .request("GET", "/api/admin/teams/team-platform/members/mem-1/config-bundle", {
      bearer: server.fixture.adminToken,
    });
  assert.equal(response.status, 200);
  const body = bodyOf<{ generator: string; files: Array<{ content: string }>; note: string }>(
    response,
  );
  assert.equal(body.generator, "stub");
  const text = JSON.stringify(body);
  assert.equal(text.includes(SECRETS.memberKey), false);
  assert.equal(text.includes("taa_member_"), false);
  assert.equal(body.files.length > 0, true);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
});

test("request text and credentials never reach a log line", async () => {
  const marker = "unique-member-message-marker-9f3a";
  const created = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    body: { kind: "suggestion", message: marker },
  });
  assert.equal(created.status, 201);
  await server.client().request("GET", "/api/team/overview", {
    bearer: server.fixture.adminToken,
  });
  const text = JSON.stringify(server.logs);
  assert.equal(text.includes(marker), false);
  assert.equal(text.includes(SECRETS.memberKey), false);
  assert.equal(text.includes("authorization"), false);
});

test("an invalid input error does not echo the submitted value", async () => {
  const submitted = "taa_unknown_key_value_123";
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: submitted,
    body: { kind: "suggestion" },
  });
  // The key is unknown, so the request is refused before validation.
  assert.equal(response.status, 401);
  assert.equal(JSON.stringify(response.body).includes(submitted), false);
});
