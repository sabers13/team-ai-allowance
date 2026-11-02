import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthMemberSource,
  createAuthenticator,
  createMemoryManagerTokenStore,
  createMemorySessionStore,
  issueManagerToken,
  SESSION_COOKIE,
  sha256Hex,
  signSessionCookie,
} from "../../src/auth/index.ts";
import type { Clock, Member } from "../../src/contracts.ts";

class ClockStub implements Clock {
  #nowMs = Date.parse("2026-10-31T09:00:00.000Z");

  now(): Date {
    return new Date(this.#nowMs);
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

const SIGNING_KEY = "principal-test-signing-value-32-char";

function makeMember(id: string, role: Member["role"], key: string | null): Member {
  return {
    id,
    teamId: "team-1",
    displayName: id,
    email: role === "member" ? null : `${id}@example.com`,
    role,
    keyAlias: `taa-${id}`,
    keyHash: key === null ? null : sha256Hex(key),
    blocked: false,
    blockedReason: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    updatedAt: "2026-10-31T09:00:00.000Z",
  };
}

class Members implements AuthMemberSource {
  readonly byId = new Map<string, Member>();

  constructor(members: Member[]) {
    for (const member of members) this.byId.set(member.id, member);
  }

  async getMember(id: string): Promise<Member | null> {
    return this.byId.get(id) ?? null;
  }

  async getMemberByKeyHash(hash: string): Promise<Member | null> {
    for (const member of this.byId.values()) {
      if (member.keyHash === hash) return member;
    }
    return null;
  }
}

function setup() {
  const clock = new ClockStub();
  const members = new Members([
    makeMember("mem-1", "member", "member-key-0001"),
    makeMember("mgr-1", "manager", "manager-key-0001"),
    makeMember("adm-1", "admin", null),
  ]);
  const tokens = createMemoryManagerTokenStore();
  const sessions = createMemorySessionStore(clock);
  const authenticator = createAuthenticator({
    members,
    tokens,
    sessions,
    sessionSecret: SIGNING_KEY,
    clock,
  });
  return { clock, members, tokens, sessions, authenticator };
}

test("a member key resolves to the member role", async () => {
  const { authenticator } = setup();
  const principal = await authenticator.authenticate({
    authorization: "Bearer member-key-0001",
    cookie: undefined,
  });
  assert.ok(principal !== null);
  assert.equal(principal.kind, "member_key");
  assert.equal(principal.role, "member");
  assert.equal(principal.member.id, "mem-1");
});

test("a manager's gateway key is still only the member role", async () => {
  const { authenticator } = setup();
  const principal = await authenticator.authenticate({
    authorization: "bearer manager-key-0001",
    cookie: undefined,
  });
  assert.ok(principal !== null);
  assert.equal(principal.kind, "member_key");
  assert.equal(principal.role, "member");
});

test("an unknown key or malformed header resolves to nobody", async () => {
  const { authenticator } = setup();
  for (const authorization of [
    undefined,
    "",
    "Bearer",
    "Basic member-key-0001",
    "Bearer not-a-key",
  ]) {
    const principal = await authenticator.authenticate({ authorization, cookie: undefined });
    assert.equal(principal, null);
  }
});

test("a manager token carries its stored role", async () => {
  const { authenticator, tokens, clock } = setup();
  const manager = await issueManagerToken(
    tokens,
    { memberId: "mgr-1", teamId: "team-1", role: "manager" },
    clock,
  );
  const admin = await issueManagerToken(
    tokens,
    { memberId: "adm-1", teamId: "team-1", role: "admin" },
    clock,
  );
  const managerPrincipal = await authenticator.authenticate({
    authorization: `Bearer ${manager.token}`,
    cookie: undefined,
  });
  assert.ok(managerPrincipal !== null);
  assert.equal(managerPrincipal.kind, "manager_token");
  assert.equal(managerPrincipal.role, "manager");
  assert.equal(managerPrincipal.tokenId, manager.record.id);

  const adminPrincipal = await authenticator.authenticate({
    authorization: `Bearer ${admin.token}`,
    cookie: undefined,
  });
  assert.ok(adminPrincipal !== null);
  assert.equal(adminPrincipal.role, "admin");
});

test("a revoked manager token stops working", async () => {
  const { authenticator, tokens, clock } = setup();
  const issued = await issueManagerToken(
    tokens,
    { memberId: "mgr-1", teamId: "team-1", role: "manager" },
    clock,
  );
  await tokens.revoke(issued.record.id, clock.now().toISOString());
  const principal = await authenticator.authenticate({
    authorization: `Bearer ${issued.token}`,
    cookie: undefined,
  });
  assert.equal(principal, null);
});

test("a session cookie resolves to a session principal", async () => {
  const { authenticator, sessions, clock } = setup();
  const session = sessions.create({ memberId: "mgr-1", teamId: "team-1", role: "manager" });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSessionCookie(session, SIGNING_KEY))}`;
  const principal = await authenticator.authenticate({ authorization: undefined, cookie });
  assert.ok(principal !== null);
  assert.equal(principal.kind, "session");
  assert.equal(principal.role, "manager");
  assert.equal(principal.csrfToken, session.csrfToken);

  clock.advance(13 * 60 * 60 * 1000);
  const expired = await authenticator.authenticate({ authorization: undefined, cookie });
  assert.equal(expired, null);
});

test("a tampered session cookie resolves to nobody", async () => {
  const { authenticator, sessions } = setup();
  const session = sessions.create({ memberId: "mgr-1", teamId: "team-1", role: "manager" });
  const cookie = `${SESSION_COOKIE}=${signSessionCookie(session, "wrong-secret-but-32-characters")}`;
  const principal = await authenticator.authenticate({ authorization: undefined, cookie });
  assert.equal(principal, null);
});

test("a token for a deleted member stops working", async () => {
  const { authenticator, tokens, clock, members } = setup();
  const issued = await issueManagerToken(
    tokens,
    { memberId: "mgr-1", teamId: "team-1", role: "manager" },
    clock,
  );
  members.byId.delete("mgr-1");
  const principal = await authenticator.authenticate({
    authorization: `Bearer ${issued.token}`,
    cookie: undefined,
  });
  assert.equal(principal, null);
});
