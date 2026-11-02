/**
 * Boundary validation, not-found, conflict and method handling.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRETS } from "./fixtures.ts";
import { bodyOf, startTestServer, type TestResponse, type TestServer } from "./harness.ts";

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function errorCode(response: TestResponse): string {
  return bodyOf<{ error: { code: string } }>(response).error.code;
}

test("invalid JSON is a 400 with the documented code", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    raw: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response), "invalid_json");
});

test("an oversized body is refused before parsing", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    raw: JSON.stringify({ kind: "suggestion", message: "x".repeat(70 * 1024) }),
  });
  assert.equal(response.status, 413);
});

test("an unsupported content type is refused", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    raw: "kind=suggestion",
    contentType: "text/plain",
  });
  assert.equal(response.status, 400);
});

test("a budget request needs an amount", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    body: { kind: "more_budget", message: "Need more." },
  });
  assert.equal(response.status, 400);
  const body = bodyOf<{ error: { details: { field: string } } }>(response);
  assert.equal(body.error.details.field, "amountUsd");
});

test("a model request needs a model id", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    body: { kind: "model_unlock", message: "Hard task." },
  });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response), "invalid_input");
});

test("an unknown request kind is refused", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    body: { kind: "unlimited_everything", message: "Please." },
  });
  assert.equal(response.status, 400);
});

test("an empty message is refused", async () => {
  const response = await server.client().request("POST", "/api/me/requests", {
    bearer: SECRETS.memberKey,
    body: { kind: "suggestion", message: "" },
  });
  assert.equal(response.status, 400);
});

test("a non-numeric limit is refused", async () => {
  const response = await server.client().request("GET", "/api/team/requests?limit=abc", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(response.status, 400);
});

test("a usage window with from after to is refused", async () => {
  const response = await server
    .client()
    .request("GET", "/api/me/usage?from=2030-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z", {
      bearer: SECRETS.memberKey,
    });
  assert.equal(response.status, 400);
});

test("an unknown route is a 404", async () => {
  const response = await server.client().request("GET", "/api/nope");
  assert.equal(response.status, 404);
  assert.equal(errorCode(response), "not_found");
});

test("a wrong method on a known route is a 405", async () => {
  const response = await server.client().request("DELETE", "/api/me", {
    bearer: SECRETS.memberKey,
  });
  assert.equal(response.status, 405);
  assert.equal(errorCode(response), "method_not_allowed");
});

test("an unknown member is a 404 for a manager", async () => {
  const response = await server.client().request("GET", "/api/team/members/mem-missing", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(response.status, 404);
});

test("deciding a request twice is a 409", async () => {
  const client = server.client();
  const first = await client.request(
    "POST",
    `/api/team/requests/${server.fixture.requestIds.data}/decide`,
    { bearer: server.fixture.adminToken, body: { outcome: "approved", permanent: true } },
  );
  assert.equal(first.status, 200);
  const second = await client.request(
    "POST",
    `/api/team/requests/${server.fixture.requestIds.data}/decide`,
    { bearer: server.fixture.adminToken, body: { outcome: "denied" } },
  );
  assert.equal(second.status, 409);
});

test("cancelling a decided request is a 409", async () => {
  const response = await server
    .client()
    .request("POST", `/api/me/requests/${server.fixture.requestIds.data}/cancel`, {
      bearer: SECRETS.memberKeyTwo,
    });
  assert.equal(response.status, 409);
});

test("cancelling someone else's request is a 404", async () => {
  const other = await server
    .client()
    .request("POST", `/api/me/requests/${server.fixture.requestIds.platform}/cancel`, {
      bearer: SECRETS.memberKeyTwo,
    });
  assert.equal(other.status, 404);
});
