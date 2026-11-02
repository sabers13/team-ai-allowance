import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GRACE_RATIO,
  DEFAULT_OFF_HOURS_CAP_USD,
  DEFAULT_SOFT_RATIO,
  DEFAULT_UNUSUAL_SPEND_MIN_USD,
  RECONCILE_INTERVAL_MS,
  REQUEST_TTL_HOURS,
  WATCH_INTERVAL_MS,
} from "../src/contracts.ts";

test("the frozen policy defaults match the specification", () => {
  assert.equal(DEFAULT_SOFT_RATIO, 0.8);
  assert.equal(DEFAULT_GRACE_RATIO, 0.05);
  assert.equal(DEFAULT_OFF_HOURS_CAP_USD, 5);
  assert.equal(DEFAULT_UNUSUAL_SPEND_MIN_USD, 2);
  assert.equal(REQUEST_TTL_HOURS, 72);
});

test("the reconciler and watcher intervals are the documented ones", () => {
  assert.equal(RECONCILE_INTERVAL_MS, 300_000);
  assert.equal(WATCH_INTERVAL_MS, 30_000);
});
