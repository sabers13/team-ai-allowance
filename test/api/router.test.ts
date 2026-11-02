import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { Router } from "../../src/api/router.ts";

function router(): Router {
  return new Router()
    .add("GET", "/api/things/:id", "member", (context) => ({
      body: { id: context.params.id ?? null },
    }))
    .add("POST", "/api/things", "manager", () => ({ body: { created: true } }));
}

test("literal and parameter segments match", () => {
  const match = router().match("GET", "/api/things/abc");
  assert.equal(match.route.pattern, "/api/things/:id");
  assert.equal(match.params.id, "abc");
});

test("trailing slashes and query strings do not confuse matching", () => {
  const match = router().match("GET", "/api/things/abc/");
  assert.equal(match.params.id, "abc");
});

test("a parameter is percent-decoded", () => {
  const match = router().match("GET", "/api/things/a%20b");
  assert.equal(match.params.id, "a b");
});

test("a known path with the wrong method is a 405", () => {
  assert.throws(
    () => router().match("DELETE", "/api/things/abc"),
    (error: unknown) => error instanceof ApiError && error.status === 405,
  );
});

test("an unknown path is a 404", () => {
  assert.throws(
    () => router().match("GET", "/api/other"),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
});
