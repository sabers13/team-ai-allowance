import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemorySessionStore,
  newLoginCsrfToken,
  verifyLoginCsrf,
  verifySessionCsrf,
} from "../../src/auth/index.ts";
import { SECRETS } from "../api/fixtures.ts";

test("the login double-submit token must match exactly", () => {
  const token = newLoginCsrfToken();
  assert.equal(verifyLoginCsrf(token, token), true);
  assert.equal(verifyLoginCsrf(token, "something-else"), false);
  assert.equal(verifyLoginCsrf(undefined, token), false);
  assert.equal(verifyLoginCsrf(token, undefined), false);
  assert.equal(verifyLoginCsrf("", ""), false);
});

test("a session CSRF token is per-session and compared in constant time", () => {
  const clock = { now: () => new Date("2026-10-31T09:00:00.000Z") };
  const store = createMemorySessionStore(clock);
  const first = store.create({ memberId: "mem-1", teamId: "team-1", role: "manager" });
  const second = store.create({ memberId: "mem-2", teamId: "team-1", role: "manager" });
  assert.notEqual(first.csrfToken, second.csrfToken);
  assert.equal(verifySessionCsrf(first, first.csrfToken), true);
  assert.equal(verifySessionCsrf(first, second.csrfToken), false);
  assert.equal(verifySessionCsrf(first, undefined), false);
  assert.equal(verifySessionCsrf(first, "x"), false);
  // The password is never the CSRF token.
  assert.equal(verifySessionCsrf(first, SECRETS.managerPassword), false);
});
