/**
 * Login, credential refusals and per-IP rate limiting.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRETS } from "./fixtures.ts";
import {
  bodyOf,
  csrfBootstrap,
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

test("a manager signs in with e-mail and password", async () => {
  const client = server.client();
  const response = await loginWithPassword(client, SECRETS.managerEmail, SECRETS.managerPassword);
  assert.equal(response.status, 200);
  const body = bodyOf<{ user: { email: string; role: string }; csrfToken: string }>(response);
  assert.equal(body.user.email, SECRETS.managerEmail);
  assert.equal(body.user.role, "manager");
  assert.equal(JSON.stringify(body).includes(SECRETS.managerPassword), false);
});

test("an admin signs in with e-mail and password", async () => {
  const response = await loginWithPassword(
    server.client(),
    SECRETS.adminEmail,
    SECRETS.adminPassword,
  );
  assert.equal(response.status, 200);
  const body = bodyOf<{ user: { role: string } }>(response);
  assert.equal(body.user.role, "admin");
});

test("a member signs in with a gateway key", async () => {
  const response = await loginWithMemberKey(server.client(), SECRETS.memberKey);
  assert.equal(response.status, 200);
  const body = bodyOf<{ user: { role: string; id: string } }>(response);
  assert.equal(body.user.role, "member");
  assert.equal(body.user.id, "mem-1");
});

test("a form-encoded login works without JavaScript", async () => {
  const client = server.client();
  const token = await csrfBootstrap(client);
  const response = await client.request("POST", "/login", {
    form: { email: SECRETS.managerEmail, password: SECRETS.managerPassword, _csrf: token },
  });
  assert.equal(response.status, 200);
});

test("login without the double-submit CSRF token is refused", async () => {
  const client = server.client();
  const response = await client.request("POST", "/login", {
    body: { email: SECRETS.managerEmail, password: SECRETS.managerPassword },
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "CSRF token is missing or invalid.");
});

test("a wrong password and an unknown e-mail get the same refusal", async () => {
  const wrongPassword = await loginWithPassword(
    server.client(),
    SECRETS.managerEmail,
    "wrong-password-123",
  );
  const unknownEmail = await loginWithPassword(
    server.client(),
    "nobody@example.com",
    "wrong-password-123",
  );
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  const first = bodyOf<{ error: { message: string } }>(wrongPassword);
  const second = bodyOf<{ error: { message: string } }>(unknownEmail);
  assert.equal(first.error.message, second.error.message);
  assert.equal(first.error.message, "E-mail or password is incorrect.");
});

test("a manager gateway key cannot log in to the console", async () => {
  const response = await loginWithMemberKey(server.client(), SECRETS.managerKey);
  assert.equal(response.status, 401);
  const body = bodyOf<{ error: { message: string } }>(response);
  assert.equal(body.error.message, "That key cannot sign in here.");
});

test("an unknown member key is refused", async () => {
  const response = await loginWithMemberKey(server.client(), "taa_unknown_key_000000");
  assert.equal(response.status, 401);
});

test("login needs either an e-mail and password or a key", async () => {
  const client = server.client();
  const token = await csrfBootstrap(client);
  const response = await client.request("POST", "/login", { body: { _csrf: token } });
  assert.equal(response.status, 400);
  const error = bodyOf<{ error: { code: string } }>(response);
  assert.equal(error.error.code, "invalid_input");
});

test("failed logins from one IP are rate limited and recover after the window", async () => {
  const limited = await startTestServer({ loginMaxAttempts: 3, loginWindowMs: 60_000 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await loginWithPassword(
        limited.client(),
        SECRETS.managerEmail,
        "nope-nope-nope",
      );
      assert.equal(response.status, 401, `attempt ${attempt + 1}`);
    }
    const blocked = await loginWithPassword(
      limited.client(),
      SECRETS.managerEmail,
      SECRETS.managerPassword,
    );
    assert.equal(blocked.status, 429);
    const retryAfter = blocked.headers.get("retry-after");
    assert.ok(retryAfter !== null && Number(retryAfter) > 0);
    const body = bodyOf<{ error: { code: string } }>(blocked);
    assert.equal(body.error.code, "rate_limited");

    limited.fixture.clock.advance(61_000);
    const recovered = await loginWithPassword(
      limited.client(),
      SECRETS.managerEmail,
      SECRETS.managerPassword,
    );
    assert.equal(recovered.status, 200);
  } finally {
    await limited.close();
  }
});

test("a successful login clears earlier failures", async () => {
  const limited = await startTestServer({ loginMaxAttempts: 3, loginWindowMs: 60_000 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await loginWithPassword(limited.client(), SECRETS.managerEmail, "nope-nope-nope");
    }
    const success = await loginWithPassword(
      limited.client(),
      SECRETS.managerEmail,
      SECRETS.managerPassword,
    );
    assert.equal(success.status, 200);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await loginWithPassword(
        limited.client(),
        SECRETS.managerEmail,
        "nope-nope-nope",
      );
      assert.equal(response.status, 401);
    }
  } finally {
    await limited.close();
  }
});
