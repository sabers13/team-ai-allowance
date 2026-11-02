import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemorySessionStore,
  signSessionCookie,
  verifySessionCookie,
} from "../../src/auth/index.ts";
import type { Clock } from "../../src/contracts.ts";
import { SECRETS } from "../api/fixtures.ts";

class ClockStub implements Clock {
  #nowMs = Date.parse("2026-10-31T09:00:00.000Z");

  now(): Date {
    return new Date(this.#nowMs);
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

test("a signed session cookie verifies", () => {
  const clock = new ClockStub();
  const store = createMemorySessionStore(clock);
  const session = store.create({ memberId: "mem-1", teamId: "team-1", role: "manager" });
  const cookie = signSessionCookie(session, SECRETS.managerPassword);
  const payload = verifySessionCookie(cookie, SECRETS.managerPassword, clock.now().getTime());
  assert.ok(payload !== null);
  assert.equal(payload.id, session.id);
});

test("a tampered session cookie is rejected", () => {
  const clock = new ClockStub();
  const store = createMemorySessionStore(clock);
  const session = store.create({ memberId: "mem-1", teamId: "team-1", role: "manager" });
  const cookie = signSessionCookie(session, "another-secret-value-32-chars-ok");
  const now = clock.now().getTime();

  assert.equal(verifySessionCookie(`${cookie}x`, "another-secret-value-32-chars-ok", now), null);
  const parts = cookie.split(".");
  assert.equal(
    verifySessionCookie(
      `${parts[0]}.${Number(parts[1]) + 1000}.${parts[2]}`,
      "another-secret-value-32-chars-ok",
      now,
    ),
    null,
  );
  assert.equal(verifySessionCookie(cookie, "wrong-secret-value-32-chars-ok", now), null);
  assert.equal(verifySessionCookie("not-a-cookie", "another-secret-value-32-chars-ok", now), null);
});

test("an expired cookie and an expired session are rejected", () => {
  const clock = new ClockStub();
  const store = createMemorySessionStore(clock);
  const session = store.create({
    memberId: "mem-1",
    teamId: "team-1",
    role: "member",
    ttlMs: 1000,
  });
  const cookie = signSessionCookie(session, "session-secret-value-32-chars-ok");
  clock.advance(1001);
  assert.equal(
    verifySessionCookie(cookie, "session-secret-value-32-chars-ok", clock.now().getTime()),
    null,
  );
  assert.equal(store.get(session.id), null);
});

test("a destroyed session is gone", () => {
  const clock = new ClockStub();
  const store = createMemorySessionStore(clock);
  const session = store.create({ memberId: "mem-1", teamId: "team-1", role: "member" });
  assert.ok(store.get(session.id) !== null);
  store.destroy(session.id);
  assert.equal(store.get(session.id), null);
});
