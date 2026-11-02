/**
 * CSRF, cookies, sessions and logout.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRETS } from "./fixtures.ts";
import {
  bodyOf,
  loginWithMemberKey,
  loginWithPassword,
  managerSessionClient,
  startTestServer,
  type TestClient,
  type TestServer,
} from "./harness.ts";

let server: TestServer;
let managerClient: TestClient;

before(async () => {
  server = await startTestServer();
  managerClient = await managerSessionClient(server);
});

after(async () => {
  await server.close();
});

test("the session cookie is httpOnly and SameSite=Strict", async () => {
  const client = server.client();
  const response = await loginWithPassword(client, SECRETS.managerEmail, SECRETS.managerPassword);
  assert.equal(response.status, 200);
  const sessionCookie = response.setCookies.find((cookie) => cookie.startsWith("taa_session="));
  assert.ok(sessionCookie !== undefined, "session cookie was set");
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Strict/i);
  assert.match(sessionCookie, /Path=\//);
  assert.match(sessionCookie, /Max-Age=43200/);
});

test("the login response carries a per-session CSRF token", async () => {
  const response = await loginWithPassword(
    server.client(),
    SECRETS.managerEmail,
    SECRETS.managerPassword,
  );
  const body = bodyOf<{ csrfToken: string; user: { role: string } }>(response);
  assert.equal(body.user.role, "manager");
  assert.ok(body.csrfToken.length >= 32);
});

test("a session mutation without a CSRF token is refused", async () => {
  const response = await managerClient.request("PATCH", "/api/team/members/mem-2/limits", {
    body: { budgetUsd: 99 },
    csrf: null,
  });
  // mem-2 is another team; the CSRF check runs first for a session mutation.
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "CSRF token is missing or invalid.");
});

test("a wrong CSRF token is refused", async () => {
  const response = await managerClient.request("PATCH", "/api/team/members/mem-1/limits", {
    body: { budgetUsd: 24 },
    csrf: "not-the-token",
  });
  assert.equal(response.status, 403);
});

test("a CSRF token in the body is accepted", async () => {
  const token = managerClient.csrfToken;
  assert.ok(token !== null);
  const response = await managerClient.request("PATCH", "/api/team/members/mem-1/limits", {
    body: { budgetUsd: 26, _csrf: token },
    csrf: null,
  });
  assert.equal(response.status, 200);
});

test("a CSRF token in the header is accepted", async () => {
  const response = await managerClient.request("PATCH", "/api/team/members/mem-1/limits", {
    body: { budgetUsd: 27 },
  });
  assert.equal(response.status, 200);
});

test("a bearer token needs no CSRF", async () => {
  const client = server.client();
  const response = await client.request("PATCH", "/api/team/members/mem-1/limits", {
    bearer: server.fixture.managerToken,
    body: { budgetUsd: 28 },
  });
  assert.equal(response.status, 200);
});

test("a read does not need a CSRF token", async () => {
  const response = await managerClient.request("GET", "/api/team/members/mem-1", { csrf: null });
  assert.equal(response.status, 200);
});

test("a cross-origin session mutation is refused even with a valid token", async () => {
  const response = await managerClient.request("PATCH", "/api/team/members/mem-1/limits", {
    body: { budgetUsd: 29 },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "Cross-origin request refused.");
});

test("a tampered session cookie is refused", async () => {
  const client = server.client();
  const login = await loginWithPassword(client, SECRETS.managerEmail, SECRETS.managerPassword);
  assert.equal(login.status, 200);
  const session = client.cookies.get("taa_session");
  assert.ok(session !== undefined);
  client.cookies.set("taa_session", `${session}tampered`);
  const response = await client.request("GET", "/api/session");
  assert.equal(response.status, 401);
});

test("logout needs CSRF, ends the session and clears the cookie", async () => {
  const client = await managerSessionClient(server);
  const withoutToken = await client.request("POST", "/logout", { csrf: null });
  assert.equal(withoutToken.status, 403);

  const response = await client.request("POST", "/logout");
  assert.equal(response.status, 200);
  assert.ok(response.setCookies.some((cookie) => /^taa_session=;/.test(cookie)));
  assert.equal(client.cookies.has("taa_session"), false);

  const after = await client.request("GET", "/api/session");
  assert.equal(after.status, 401);
});

test("a session expires after twelve hours", async () => {
  const shortServer = await startTestServer({ sessionTtlMs: 60 * 60 * 1000 });
  try {
    const client = await managerSessionClient(shortServer);
    assert.equal((await client.request("GET", "/api/session")).status, 200);
    shortServer.fixture.clock.advance(61 * 60 * 1000);
    const response = await client.request("GET", "/api/session");
    assert.equal(response.status, 401);
  } finally {
    await shortServer.close();
  }
});

test("a member session can read its own allowance", async () => {
  const client = server.client();
  const login = await loginWithMemberKey(client, SECRETS.memberKey);
  assert.equal(login.status, 200);
  const me = await client.request("GET", "/api/me");
  assert.equal(me.status, 200);
  const body = bodyOf<{ displayName: string; status: string }>(me);
  assert.equal(body.displayName, "Lena");
  assert.equal(body.status, "ok");
});

test("the session endpoint reports the CSRF token only for cookie sessions", async () => {
  const session = await managerClient.request("GET", "/api/session");
  const sessionBody = bodyOf<{ csrfToken: string | null }>(session);
  assert.ok(sessionBody.csrfToken !== null);

  const bearer = await server.client().request("GET", "/api/session", {
    bearer: server.fixture.managerToken,
  });
  const bearerBody = bodyOf<{ csrfToken: string | null; user: { role: string } }>(bearer);
  assert.equal(bearerBody.csrfToken, null);
  assert.equal(bearerBody.user.role, "manager");
});
