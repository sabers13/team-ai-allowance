import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../../src/auth/index.ts";

test("a password hash is scrypt with a random salt", async () => {
  const first = await hashPassword("correct-horse-battery");
  const second = await hashPassword("correct-horse-battery");
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes("correct-horse-battery"), false);
});

test("the right password verifies and a wrong one does not", async () => {
  const hash = await hashPassword("correct-horse-battery");
  assert.equal(await verifyPassword("correct-horse-battery", hash), true);
  assert.equal(await verifyPassword("correct-horse-batterY", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("a password shorter than the minimum is refused", async () => {
  await assert.rejects(() => hashPassword("short"), /at least/);
  assert.equal(
    await verifyPassword("short", await hashPassword("x".repeat(MIN_PASSWORD_LENGTH))),
    false,
  );
});

test("a malformed stored hash fails closed", async () => {
  for (const malformed of [
    "",
    "plain-text",
    "scrypt$not$numbers$here$aa$bb",
    "scrypt$16384$8$1$zz$zz",
    "bcrypt$16384$8$1$aa$bb",
  ]) {
    assert.equal(await verifyPassword("anything", malformed), false);
  }
});
