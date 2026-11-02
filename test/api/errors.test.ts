import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, asApiError } from "../../src/api/errors.ts";
import { DomainError } from "../../src/core/index.ts";

test("core domain refusals map to the documented statuses", () => {
  const cases: Array<[DomainError["code"], number, string]> = [
    ["invalid_input", 400, "invalid_input"],
    ["invalid_state", 409, "conflict"],
    ["not_found", 404, "not_found"],
    ["forbidden", 403, "forbidden"],
    ["expired", 409, "conflict"],
    ["conflict", 409, "conflict"],
  ];
  for (const [domainCode, status, apiCode] of cases) {
    const mapped = asApiError(new DomainError(domainCode, "A safe sentence."));
    assert.equal(mapped.status, status, domainCode);
    assert.equal(mapped.code, apiCode, domainCode);
    assert.equal(mapped.message, "A safe sentence.");
  }
});

test("a gateway failure does not pass upstream detail to the caller", () => {
  const mapped = asApiError(new DomainError("gateway_failure", "upstream body: secret details"));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.code, "internal");
  assert.equal(mapped.message, "The gateway is unavailable.");
  assert.equal(mapped.message.includes("secret details"), false);
});

test("an unexpected error is a generic 500", () => {
  const mapped = asApiError(new Error("connection string postgres://user:pass@host"));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.code, "internal");
  assert.equal(mapped.message, "Unexpected server error.");
  assert.equal(mapped.message.includes("postgres"), false);
});

test("an ApiError passes through unchanged", () => {
  const original = new ApiError(422, "over_limit", "That is over the limit.", { limit: 10 });
  const mapped = asApiError(original);
  assert.equal(mapped, original);
});
