import assert from "node:assert/strict";
import { test } from "node:test";
import type { Member, Request } from "../../src/contracts.ts";
import { DomainError } from "../../src/core/errors.ts";
import {
  buildRequest,
  cancelRequest,
  type Decider,
  decideRequest,
  expireRequest,
  isRequestDue,
} from "../../src/core/requests.ts";

const NOW = new Date("2026-10-05T09:00:00Z");

const member: Member = {
  id: "mem_1",
  teamId: "team_1",
  displayName: "Lena",
  email: null,
  role: "member",
  keyAlias: "taa-mem_1",
  keyHash: "hash",
  blocked: false,
  blockedReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const manager: Decider = {
  type: "manager",
  id: "user_priya",
  role: "manager",
  source: "manager",
  displayName: "Priya",
};

const context = {
  spendThisPeriodUsd: 12.5,
  limitUsd: 20,
  topModels: [{ modelId: "luna", spendUsd: 10 }],
  last7DaysUsd: 40,
};

function makeRequest(
  overrides: {
    kind?: Request["kind"];
    amountUsd?: number;
    modelId?: string;
    message?: string;
  } = {},
): Request {
  return buildRequest({
    id: "req_1",
    member,
    kind: overrides.kind ?? "more_budget",
    message: overrides.message ?? "  a migration needs a bit more  ",
    context,
    now: NOW,
    ...(overrides.amountUsd === undefined ? { amountUsd: 5 } : { amountUsd: overrides.amountUsd }),
    ...(overrides.modelId === undefined ? {} : { modelId: overrides.modelId }),
  });
}

const options = { now: NOW, grantId: "grn_1", decisionId: "dec_1", budgetPeriod: "daily" as const };

test("create attaches the context and a 72-hour deadline", () => {
  const request = makeRequest();
  assert.equal(request.state, "pending");
  assert.equal(request.memberId, "mem_1");
  assert.equal(request.teamId, "team_1");
  assert.equal(request.message, "a migration needs a bit more");
  assert.deepEqual(request.context, context);
  assert.equal(request.createdAt, "2026-10-05T09:00:00.000Z");
  assert.equal(request.expiresAt, "2026-10-08T09:00:00.000Z");
  assert.equal(request.decidedAt, null);
});

test("create validates each kind", () => {
  assert.throws(() => makeRequest({ kind: "more_budget", amountUsd: 0 }), /positive amount/);
  assert.throws(() => makeRequest({ kind: "more_budget", amountUsd: -1 }), /positive amount/);
  assert.throws(() => makeRequest({ kind: "more_budget", message: "  " }), /reason/);
  assert.throws(() => makeRequest({ kind: "model_unlock" }), /model id/);
  assert.throws(() => makeRequest({ message: "x".repeat(2001) }), /at most 2000/);
  const unlock = makeRequest({ kind: "model_unlock", modelId: "flagship" });
  assert.equal(unlock.modelId, "flagship");
  assert.equal(unlock.amountUsd, null);
  const suggestion = makeRequest({ kind: "suggestion" });
  assert.equal(suggestion.amountUsd, null);
  assert.equal(suggestion.modelId, null);
});

test("a full approval creates a budget grant until the end of the period", () => {
  const request = makeRequest({ amountUsd: 5 });
  const result = decideRequest(
    request,
    { outcome: "approved", note: " go ahead " },
    manager,
    options,
  );
  assert.equal(result.request.state, "approved");
  assert.equal(result.request.decidedAt, "2026-10-05T09:00:00.000Z");
  assert.equal(result.decision.outcome, "approved");
  assert.equal(result.decision.source, "manager");
  assert.equal(result.decision.decidedById, "user_priya");
  assert.equal(result.decision.decidedByRole, "manager");
  assert.equal(result.decision.note, "go ahead");
  assert.equal(result.decision.grantedAmountUsd, 5);
  assert.equal(result.decision.grantId, "grn_1");
  assert.ok(result.grant);
  assert.equal(result.grant.scope, "budget");
  assert.equal(result.grant.amountUsd, 5);
  assert.equal(result.grant.requestId, "req_1");
  assert.equal(result.grant.expiresAt, "2026-10-06T00:00:00.000Z");
  assert.equal(result.grant.revokedAt, null);
});

test("a partial approval grants less and records partly_approved", () => {
  const request = makeRequest({ amountUsd: 10 });
  const result = decideRequest(
    request,
    { outcome: "partly_approved", amountUsd: 3 },
    manager,
    options,
  );
  assert.equal(result.request.state, "partly_approved");
  assert.equal(result.decision.grantedAmountUsd, 3);
  assert.equal(result.grant?.amountUsd, 3);
});

test("outcome and amount must agree, and a denial creates no grant", () => {
  const request = makeRequest({ amountUsd: 10 });
  assert.throws(
    () => decideRequest(request, { outcome: "partly_approved", amountUsd: 10 }, manager, options),
    /less than/,
  );
  assert.throws(
    () => decideRequest(request, { outcome: "approved", amountUsd: 3 }, manager, options),
    /exactly the requested/,
  );
  const denied = decideRequest(
    request,
    { outcome: "denied", note: "use the enabled model" },
    manager,
    options,
  );
  assert.equal(denied.request.state, "denied");
  assert.equal(denied.grant, null);
  assert.equal(denied.decision.grantId, null);
  assert.equal(denied.decision.note, "use the enabled model");
});

test("a model unlock defaults to 24 hours and can be until or permanent", () => {
  const request = makeRequest({ kind: "model_unlock", modelId: "flagship" });
  const granted = decideRequest(request, { outcome: "approved" }, manager, options);
  assert.equal(granted.grant?.scope, "model");
  assert.equal(granted.grant?.modelId, "flagship");
  assert.equal(granted.grant?.expiresAt, "2026-10-06T09:00:00.000Z");

  const until = decideRequest(
    request,
    { outcome: "approved", until: "2026-10-05T09:15:00.000Z" },
    manager,
    options,
  );
  assert.equal(until.grant?.expiresAt, "2026-10-05T09:15:00.000Z");

  const dateOnly = decideRequest(
    request,
    { outcome: "approved", until: "2026-10-07" },
    manager,
    options,
  );
  assert.equal(dateOnly.grant?.expiresAt, "2026-10-07T23:59:59.999Z");

  const permanent = decideRequest(
    request,
    { outcome: "approved", permanent: true },
    manager,
    options,
  );
  assert.equal(permanent.grant?.expiresAt, null);
});

test("model decisions cannot be partial, and cannot swap the model", () => {
  const request = makeRequest({ kind: "model_unlock", modelId: "flagship" });
  assert.throws(
    () => decideRequest(request, { outcome: "partly_approved", amountUsd: 1 }, manager, options),
    /cannot be partly/,
  );
  assert.throws(
    () => decideRequest(request, { outcome: "approved", modelId: "other" }, manager, options),
    /only unlock the model/,
  );
});

test("until must be in the future and cannot be combined with permanent", () => {
  const request = makeRequest();
  assert.throws(
    () =>
      decideRequest(
        request,
        { outcome: "approved", until: "2026-10-05T08:00:00Z" },
        manager,
        options,
      ),
    /future/,
  );
  assert.throws(
    () =>
      decideRequest(
        request,
        { outcome: "approved", until: "2026-10-07", permanent: true },
        manager,
        options,
      ),
    /both permanent/,
  );
});

test("a decision is refused once the request is not pending or is past 72 hours", () => {
  const request = makeRequest();
  const decided = decideRequest(request, { outcome: "approved" }, manager, options);
  assert.throws(
    () => decideRequest(decided.request, { outcome: "denied" }, manager, options),
    /not pending/,
  );

  const later = new Date(request.expiresAt);
  const error = (() => {
    try {
      decideRequest(request, { outcome: "approved" }, manager, { ...options, now: later });
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "expired");
  assert.equal(isRequestDue(request, later), true);
});

test("cancel and expire only apply to a pending request", () => {
  const request = makeRequest({ kind: "suggestion" });
  const cancelled = cancelRequest(request);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.decidedAt, null);
  assert.throws(() => cancelRequest(cancelled), /not pending/);

  const expired = expireRequest(request);
  assert.equal(expired.state, "expired");
  assert.throws(() => expireRequest(expired), /not pending/);
});

test("a suggestion is approved without a grant", () => {
  const request = makeRequest({ kind: "suggestion" });
  const result = decideRequest(request, { outcome: "approved" }, manager, options);
  assert.equal(result.request.state, "approved");
  assert.equal(result.decision.grantId, null);
  assert.equal(result.grant, null);
  assert.throws(
    () => decideRequest(request, { outcome: "partly_approved" }, manager, options),
    /cannot be partly/,
  );
});
