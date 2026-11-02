import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateHashes, hashHex, scanText, tokenize } from "../scripts/scan-forbidden.ts";

test("tokens are lowercased, punctuation-trimmed and split on the fixed class", () => {
  assert.deepEqual(tokenize("Hello, Qwzxv.Jv-99!"), ["hello", "qwzxv.jv-99"]);
  assert.deepEqual(tokenize("...+_---"), []);
  assert.deepEqual(tokenize("a_b"), ["a_b"]);
});

test("a token contributes its own hash and each part's hash", () => {
  const hashes = candidateHashes("one.two-three");
  assert.equal(hashes.length, 4);
  assert.ok(hashes.includes(hashHex("one.two-three")));
  assert.ok(hashes.includes(hashHex("one")));
  assert.ok(hashes.includes(hashHex("two")));
  assert.ok(hashes.includes(hashHex("three")));
});

test("a match reports a location and a prefix, never the token", () => {
  const forbidden = new Set([hashHex("qwzxv")]);
  const hits = scanText("first line\nsecond has QWZXV inside\n", forbidden, "doc.md");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.location, "doc.md:2");
  assert.equal(hits[0]?.hashPrefix, hashHex("qwzxv").slice(0, 12));
  assert.ok(!JSON.stringify(hits).includes("qwzxv"));
});

test("a clean line produces no hit", () => {
  const hits = scanText("nothing to see here\n", new Set([hashHex("qwzxv")]), "doc.md");
  assert.deepEqual(hits, []);
});
