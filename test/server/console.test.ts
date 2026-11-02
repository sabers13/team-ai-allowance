import assert from "node:assert/strict";
import { test } from "node:test";
import type { Viewer } from "../../src/console/data.ts";
import type { ConsoleResponse } from "../../src/console/index.ts";
import { resolveConsoleSession } from "../../src/server/console.ts";
import { CSRF, SESSION_SECRET, seedTwoTeams } from "./harness.ts";

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

async function login(
  fixture: Awaited<ReturnType<typeof seedTwoTeams>>,
  values: Record<string, string>,
  ip = "127.0.0.1",
): Promise<ConsoleResponse> {
  return fixture.consoleFor(null).handle({
    method: "POST",
    url: "/login",
    headers: {},
    form: form(values),
    cookies: {},
    session: null,
    ip,
  });
}

function viewerFor(
  role: "manager" | "member",
  memberId: string,
  teamId: string,
  email: string | null = null,
): Viewer {
  return {
    role,
    displayName: role === "manager" ? "Mara" : "Lena",
    teamId,
    teamName: "",
    memberId,
    csrfToken: CSRF,
    email,
  };
}

test("a member signs in with the gateway key and reaches My allowance", async () => {
  const fixture = await seedTwoTeams();
  try {
    const response = await login(fixture, { memberKey: fixture.memberA.secret, next: "/" });
    assert.equal(response.status, 303);
    const cookie = response.headers["set-cookie"] ?? "";
    assert.match(cookie, /taa_session=/);
    const session = resolveConsoleSession(cookie.split(";")[0], {
      sessions: fixture.sessions,
      sessionSecret: SESSION_SECRET,
      clock: fixture.clock,
    });
    assert.ok(session);
    assert.equal(session.role, "member");

    const viewer = viewerFor("member", session.memberId, session.teamId);
    const me = await fixture.consoleFor(viewer).handle({
      method: "GET",
      url: "/me",
      headers: {},
      form: null,
      cookies: {},
      session: viewer,
    });
    assert.equal(me.status, 200);
    assert.match(me.body, /My allowance/);
    assert.match(me.body, /Remaining/);
  } finally {
    fixture.close();
  }
});

test("a wrong member key is refused and a good one is accepted once", async () => {
  const fixture = await seedTwoTeams();
  try {
    const wrong = await login(fixture, { memberKey: "sk-not-a-key" });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body, /not valid/);
  } finally {
    fixture.close();
  }
});

test("the console login does not reveal account existence and is rate-limited", async () => {
  const fixture = await seedTwoTeams();
  try {
    const unknown = await login(
      fixture,
      { email: "nobody@example.test", password: "x" },
      "10.0.0.1",
    );
    const wrong = await login(
      fixture,
      { email: fixture.managerEmail, password: "wrong-password" },
      "10.0.0.1",
    );
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(
      unknown.body.match(/E-mail or password is incorrect\./)?.[0],
      "E-mail or password is incorrect.",
    );
    assert.equal(
      wrong.body.match(/E-mail or password is incorrect\./)?.[0],
      "E-mail or password is incorrect.",
    );

    const third = await login(
      fixture,
      { email: fixture.managerEmail, password: "wrong-password" },
      "10.0.0.1",
    );
    assert.equal(third.status, 401);
    const fourth = await login(
      fixture,
      { email: fixture.managerEmail, password: "wrong-password" },
      "10.0.0.1",
    );
    assert.equal(fourth.status, 429);
    assert.match(fourth.body, /Too many sign-in attempts/);
  } finally {
    fixture.close();
  }
});

test("a manager password login still works", async () => {
  const fixture = await seedTwoTeams();
  try {
    const response = await login(fixture, {
      email: fixture.managerEmail,
      password: fixture.managerPassword,
    });
    assert.equal(response.status, 303);
    const session = resolveConsoleSession((response.headers["set-cookie"] ?? "").split(";")[0], {
      sessions: fixture.sessions,
      sessionSecret: SESSION_SECRET,
      clock: fixture.clock,
    });
    assert.equal(session?.role, "manager");
  } finally {
    fixture.close();
  }
});

test("a manager console form cannot touch another team's member or request", async () => {
  const fixture = await seedTwoTeams();
  try {
    const viewer = viewerFor("manager", fixture.managerA.memberId, fixture.teamA.id);
    const console = fixture.consoleFor(viewer);
    const limits = await console.handle({
      method: "POST",
      url: `/members/${fixture.memberB.id}/limits`,
      headers: {},
      form: form({
        _csrf: CSRF,
        budgetUsd: "999",
        period: "monthly",
        returnTo: `/members/${fixture.memberB.id}`,
      }),
      cookies: {},
      session: viewer,
    });
    assert.equal(limits.status, 404);
    assert.match(limits.body, /not in this team/);
    assert.equal((await fixture.store.getLimits(fixture.memberB.id))?.budgetUsd, 20);

    const request = await fixture.control.createRequest({
      memberId: fixture.memberB.id,
      teamId: fixture.teamB.id,
      kind: "more_budget",
      amountUsd: 5,
      modelId: null,
      message: "please",
    });
    const decide = await console.handle({
      method: "POST",
      url: `/requests/${request.id}/decide`,
      headers: {},
      form: form({ _csrf: CSRF, outcome: "approved", note: "", returnTo: "/requests" }),
      cookies: {},
      session: viewer,
    });
    assert.equal(decide.status, 404);
    assert.equal((await fixture.store.getRequest(request.id))?.state, "pending");
  } finally {
    fixture.close();
  }
});

test("the member page shows the effective blocked status and a member audit trail", async () => {
  const fixture = await seedTwoTeams();
  try {
    await fixture.control.setLimits(fixture.managerA, fixture.memberA.id, {
      budgetUsd: 1,
      period: "monthly",
    });
    await fixture.control.setLimits(fixture.managerA, fixture.memberA.id, {
      budgetUsd: 0.01,
      period: "monthly",
    });
    await fixture.store.recordUsage([
      {
        id: "use_block",
        memberId: fixture.memberA.id,
        modelId: "mock-cheap",
        at: fixture.clock.now().toISOString(),
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 1,
        requestId: "gw_block",
      },
    ]);
    const viewer = viewerFor("manager", fixture.managerA.memberId, fixture.teamA.id);
    const response = await fixture.consoleFor(viewer).handle({
      method: "GET",
      url: `/members/${fixture.memberA.id}`,
      headers: {},
      form: null,
      cookies: {},
      session: viewer,
    });
    assert.equal(response.status, 200);
    // The manual block flag is false, but the policy is blocked by spend.
    assert.match(response.body, /pill--blocked/);
    assert.match(response.body, /limits\.updated/);
    assert.match(response.body, new RegExp(`/audit\\?objectId=${fixture.memberA.id}`));
  } finally {
    fixture.close();
  }
});
