import assert from "node:assert/strict";
import { test } from "node:test";
import {
  median,
  parseWatcherBlockReason,
  reachedThresholds,
  unusualSpendThreshold,
  unusualSpendTrigger,
  watcherBlockReason,
} from "../../src/watcher/caps.ts";

const THRESHOLDS = { softRatio: 0.8, graceRatio: 0.05 };

test("thresholds fire at their exact boundaries, hardest first", () => {
  assert.deepEqual(reachedThresholds(7.99, 10, THRESHOLDS), []);
  assert.deepEqual(reachedThresholds(8, 10, THRESHOLDS), ["soft_limit"]);
  assert.deepEqual(reachedThresholds(9.99, 10, THRESHOLDS), ["soft_limit"]);
  assert.deepEqual(reachedThresholds(10, 10, THRESHOLDS), ["grace", "soft_limit"]);
  assert.deepEqual(reachedThresholds(10.49, 10, THRESHOLDS), ["grace", "soft_limit"]);
  assert.deepEqual(reachedThresholds(10.5, 10, THRESHOLDS), ["hard_limit", "grace", "soft_limit"]);
  assert.deepEqual(reachedThresholds(10.51, 10, THRESHOLDS), ["hard_limit", "grace", "soft_limit"]);
});

test("a configured soft ratio changes the soft boundary", () => {
  assert.deepEqual(reachedThresholds(4.99, 10, { softRatio: 0.5, graceRatio: 0.3 }), []);
  assert.deepEqual(reachedThresholds(5, 10, { softRatio: 0.5, graceRatio: 0.3 }), ["soft_limit"]);
});

test("median handles empty, odd and even samples", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3]), 3);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("the unusual threshold is max(3 x median, minimum)", () => {
  assert.equal(unusualSpendThreshold([], 2), 2);
  assert.equal(unusualSpendThreshold([0.1, 0.1, 0.1], 2), 2);
  assert.equal(unusualSpendThreshold([10, 10, 10], 2), 30);
});

test("unusual spend needs both three times the median and the minimum", () => {
  assert.equal(unusualSpendTrigger(1.99, [0.1], 2), false);
  assert.equal(unusualSpendTrigger(2, [0.1], 2), true);
  assert.equal(unusualSpendTrigger(2.01, [0.1], 2), true);
  assert.equal(unusualSpendTrigger(0.02, [], 0.01), true);
  assert.equal(unusualSpendTrigger(0, [], 0.01), false);
  assert.equal(unusualSpendTrigger(29, [10, 10, 10], 2), false);
  assert.equal(unusualSpendTrigger(30, [10, 10, 10], 2), true);
  assert.equal(unusualSpendTrigger(31, [10, 10, 10], 2), true);
});

test("a watcher block reason round-trips its kind and unblock instant", () => {
  const until = new Date("2026-10-12T05:00:00.000Z");
  const reason = watcherBlockReason("off_hours", "USD 5.20 of USD 5.00 since Fri 19:00", until);
  const parsed = parseWatcherBlockReason(reason);
  assert.equal(parsed?.kind, "off_hours");
  assert.equal(parsed?.until.toISOString(), until.toISOString());

  const token = watcherBlockReason("token_cap", "120 of 100 tokens", until);
  assert.equal(parseWatcherBlockReason(token)?.kind, "token_cap");
});

test("a manager's plain block reason is not a watcher block", () => {
  assert.equal(parseWatcherBlockReason("policy review"), null);
  assert.equal(parseWatcherBlockReason(null), null);
});
