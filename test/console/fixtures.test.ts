import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixtureConsole } from "../../src/console/fixtures.ts";

function statusByName(
  rows: Array<{ member: { displayName: string }; policy: { status: string } }>,
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.member.displayName, row.policy.status]));
}

test("the fixture keeps one member in every status", async () => {
  const fixture = createFixtureConsole();
  const overview = await fixture.data.overview({ key: "name", direction: "asc" });
  const statuses = statusByName(overview.members);
  assert.equal(statuses.Lena, "soft");
  assert.equal(statuses.Omar, "ok");
  assert.equal(statuses.Mira, "grace");
  assert.equal(statuses.Jonas, "blocked");
});

test("member spend matches the generated usage and the configured targets", async () => {
  const fixture = createFixtureConsole();
  const overview = await fixture.data.overview({ key: "name", direction: "asc" });
  const spend = Object.fromEntries(
    overview.members.map((row) => [row.member.displayName, row.spendUsd]),
  );
  assert.equal(spend.Lena, 16.8);
  assert.equal(spend.Omar, 12.4);
  assert.equal(spend.Mira, 20.8);
  assert.equal(spend.Jonas, 4.2);

  const lena = await fixture.data.memberDetail("mem_lena");
  assert.ok(lena);
  const periodSpend = lena.usage
    .filter((row) => Date.parse(row.at) >= Date.parse("2026-10-25T00:00:00Z"))
    .reduce((sum, row) => sum + row.costUsd, 0);
  assert.ok(Math.abs(periodSpend - 16.8) < 0.02);
});

test("team spend is the sum of the members' month spend", async () => {
  const fixture = createFixtureConsole();
  const overview = await fixture.data.overview({ key: "spend", direction: "desc" });
  const month = overview.members.reduce((sum, row) => sum + row.monthSpendUsd, 0);
  assert.ok(Math.abs(overview.teamSpendUsd - month) < 0.02);
  assert.equal(overview.members[0]?.member.displayName, "Priya");
});

test("sorting changes the member order", async () => {
  const fixture = createFixtureConsole();
  const asc = await fixture.data.overview({ key: "spend", direction: "asc" });
  const desc = await fixture.data.overview({ key: "spend", direction: "desc" });
  assert.equal(asc.members[0]?.member.displayName, "Jonas");
  assert.equal(desc.members[0]?.member.displayName, "Priya");
});

test("the request inbox is pending only, the history is decided only", async () => {
  const fixture = createFixtureConsole();
  const inbox = await fixture.data.requests({
    view: "inbox",
    state: "all",
    memberId: null,
    query: "",
    limit: 50,
  });
  const history = await fixture.data.requests({
    view: "history",
    state: "all",
    memberId: null,
    query: "",
    limit: 50,
  });
  assert.equal(inbox.length, 4);
  assert.equal(
    inbox.every((request) => request.state === "pending"),
    true,
  );
  assert.equal(history.length, 5);
  assert.equal(
    history.every((request) => request.state !== "pending"),
    true,
  );
});

test("the model request carries a cheaper-option hint", async () => {
  const fixture = createFixtureConsole();
  const detail = await fixture.data.requestDetail("req_0002");
  assert.ok(detail);
  assert.equal(detail.request.modelId, "flagship-9");
  assert.match(detail.hint ?? "", /cheaper than Flagship 9/);
});

test("the catalogue counts model requests in the last 30 days", async () => {
  const fixture = createFixtureConsole();
  const models = await fixture.data.models();
  const flagship = models.models.find((row) => row.model.id === "flagship-9");
  assert.ok(flagship);
  assert.equal(flagship.requestsLast30Days, 2);
});

test("the member page carries grants, usage and audit", async () => {
  const fixture = createFixtureConsole();
  const lena = await fixture.data.memberDetail("mem_lena");
  assert.ok(lena);
  assert.equal(
    lena.grants.some((grant) => grant.scope === "budget"),
    true,
  );
  assert.equal(lena.usage.length > 0, true);
  assert.equal(lena.audit.length > 0, true);
  assert.equal(lena.keyState.blocked, false);
});

test("my allowance subtracts spend from the effective budget", async () => {
  const fixture = createFixtureConsole();
  const me = await fixture.data.me(fixture.viewer);
  assert.ok(me);
  assert.equal(me.policy.effectiveBudgetUsd, 50);
  assert.ok(me.spendUsd < me.policy.effectiveBudgetUsd);
  assert.equal(
    me.allowedModels.some((model) => model.id === "deepseek-v4.1-flash"),
    true,
  );
});

test("a bundle is a text file and never contains a key", async () => {
  const fixture = createFixtureConsole();
  const bundle = await fixture.data.bundle("mem_lena");
  assert.ok(bundle);
  assert.equal(bundle.contentType.startsWith("text/plain"), true);
  assert.equal(bundle.body.includes("__paste_the_key_shown_at_enrolment__"), true);
  assert.equal(bundle.body.includes("taa_key_fixture"), false);
});

test("the setup page reports each member's last doctor run", async () => {
  const fixture = createFixtureConsole();
  const setup = await fixture.data.setup();
  const lena = setup.members.find((row) => row.member.id === "mem_lena");
  assert.ok(lena);
  assert.equal(lena.reports.length, 3);
  assert.equal(
    lena.reports.some((report) => report.gatewayOk === false),
    false,
  );
});

test("deciding a request writes a decision, a grant and an audit event", async () => {
  const fixture = createFixtureConsole();
  const before = await fixture.data.memberDetail("mem_lena");
  assert.ok(before);
  const receipt = await fixture.actions.decide("req_0001", {
    outcome: "approved",
    note: "One week.",
    amountUsd: null,
    modelId: null,
    until: null,
    permanent: false,
  });
  assert.match(receipt.message, /approved/);
  const detail = await fixture.data.requestDetail("req_0001");
  assert.equal(detail?.request.state, "approved");
  assert.equal(detail?.decisions.length, 1);
  const after = await fixture.data.memberDetail("mem_lena");
  assert.ok(after);
  assert.equal(after.grants.length, before.grants.length + 1);
  assert.equal(after.policy.effectiveBudgetUsd, 30);
  const audit = await fixture.data.audit({
    actorId: null,
    objectType: null,
    objectId: null,
    from: null,
    to: null,
    limit: 5,
    offset: 0,
  });
  assert.equal(audit[0]?.action, "request.approved");
});

test("partly approving above the requested amount is refused", async () => {
  const fixture = createFixtureConsole();
  await assert.rejects(
    fixture.actions.decide("req_0001", {
      outcome: "partly_approved",
      note: null,
      amountUsd: 99,
      modelId: null,
      until: null,
      permanent: false,
    }),
    /requested amount is 10\.00/,
  );
});

test("a member can ask from My allowance and cancel the request", async () => {
  const fixture = createFixtureConsole();
  const created = await fixture.actions.createRequest({
    kind: "more_budget",
    amountUsd: 5,
    modelId: null,
    message: "One more test run.",
  });
  assert.match(created.message, /sent/);
  const me = await fixture.data.me(fixture.viewer);
  const pending = me?.requests.find((request) => request.message === "One more test run.");
  assert.ok(pending);
  const cancelled = await fixture.actions.cancelRequest(pending.id);
  assert.equal(cancelled.message, "Request cancelled.");
  const after = await fixture.data.me(fixture.viewer);
  assert.equal(after?.requests.find((request) => request.id === pending.id)?.state, "cancelled");
});

test("enrolment returns the secret once and never stores it", async () => {
  const fixture = createFixtureConsole();
  const receipt = await fixture.actions.enrolMember({
    displayName: "Nora",
    email: "nora@example.com",
    role: "member",
    budgetUsd: 25,
    period: "weekly",
  });
  assert.ok(receipt.secret);
  assert.equal(receipt.secret?.startsWith("taa_key_fixture_"), true);
  const setup = await fixture.data.setup();
  const nora = setup.members.find((row) => row.member.displayName === "Nora");
  assert.ok(nora);
  assert.equal(nora.member.keyHash !== null, true);
  assert.equal(nora.member.keyHash?.includes(receipt.secret ?? "x"), false);
});

test("a rotated key returns a new secret and keeps a hash", async () => {
  const fixture = createFixtureConsole();
  const receipt = await fixture.actions.keyAction("mem_lena", "rotate", null);
  assert.ok(receipt.secret);
  const detail = await fixture.data.memberDetail("mem_lena");
  assert.equal(detail?.member.keyHash?.length, 64);
  assert.equal(detail?.member.keyHash?.includes(receipt.secret ?? "x"), false);
});

test("policy changes are validated", async () => {
  const fixture = createFixtureConsole();
  const { policy } = await fixture.data.rules();
  await assert.rejects(
    fixture.actions.savePolicy({ ...policy, thresholds: { softRatio: 0, graceRatio: 0.05 } }),
    /soft limit/,
  );
});

test("the default fixture never includes prompt or response text", async () => {
  const fixture = createFixtureConsole();
  const requests = await fixture.data.requests({
    view: "history",
    state: "all",
    memberId: null,
    query: "",
    limit: 100,
  });
  for (const request of requests) {
    assert.equal("prompt" in request, false);
    assert.equal("response" in request, false);
  }
  const pages = await fixture.data.memberDetail("mem_lena");
  assert.equal(JSON.stringify(pages).includes("You are a helpful"), false);
});
