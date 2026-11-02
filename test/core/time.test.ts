import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../../src/core/clock.ts";
import {
  addDays,
  addHours,
  fromIso,
  isAtOrBefore,
  isBefore,
  parseInstant,
  parseUntil,
  periodEnd,
  periodStart,
  startOfDayUtc,
  startOfMonthUtc,
  startOfWeekUtc,
  toIso,
} from "../../src/core/time.ts";

test("period boundaries are UTC calendar boundaries", () => {
  const wednesday = new Date("2026-10-07T15:30:00Z");
  assert.equal(toIso(periodStart("daily", wednesday)), "2026-10-07T00:00:00.000Z");
  assert.equal(toIso(periodEnd("daily", wednesday)), "2026-10-08T00:00:00.000Z");
  assert.equal(toIso(periodStart("weekly", wednesday)), "2026-10-05T00:00:00.000Z");
  assert.equal(toIso(periodEnd("weekly", wednesday)), "2026-10-12T00:00:00.000Z");
  assert.equal(toIso(periodStart("monthly", wednesday)), "2026-10-01T00:00:00.000Z");
  assert.equal(toIso(periodEnd("monthly", wednesday)), "2026-11-01T00:00:00.000Z");
});

test("week, day and month starts handle Sunday and December", () => {
  const sunday = new Date("2026-12-27T23:59:59Z");
  assert.equal(toIso(startOfWeekUtc(sunday)), "2026-12-21T00:00:00.000Z");
  assert.equal(toIso(startOfDayUtc(sunday)), "2026-12-27T00:00:00.000Z");
  assert.equal(toIso(startOfMonthUtc(sunday)), "2026-12-01T00:00:00.000Z");
  assert.equal(toIso(periodEnd("monthly", sunday)), "2027-01-01T00:00:00.000Z");
});

test("instants must carry an explicit offset", () => {
  assert.equal(toIso(parseInstant("2026-10-05T09:00:00Z")), "2026-10-05T09:00:00.000Z");
  assert.equal(toIso(parseInstant("2026-10-05T11:00:00+02:00")), "2026-10-05T09:00:00.000Z");
  assert.equal(toIso(parseInstant("2026-10-05T09:00Z")), "2026-10-05T09:00:00.000Z");
  assert.throws(() => parseInstant("2026-10-05"), /explicit offset/);
  assert.throws(() => parseInstant("2026-10-05T09:00:00"), /explicit offset/);
  assert.throws(() => fromIso("not a date"), /valid ISO/);
});

test("a date-only until means the end of that day", () => {
  assert.equal(toIso(parseUntil("2026-11-02")), "2026-11-02T23:59:59.999Z");
  assert.equal(toIso(parseUntil("2026-11-02T12:00:00Z")), "2026-11-02T12:00:00.000Z");
});

test("arithmetic and comparisons", () => {
  const at = new Date("2026-10-05T09:00:00Z");
  assert.equal(toIso(addHours(at, 2)), "2026-10-05T11:00:00.000Z");
  assert.equal(toIso(addDays(at, 1)), "2026-10-06T09:00:00.000Z");
  assert.equal(isBefore("2026-10-05T09:00:00Z", "2026-10-05T09:00:01Z"), true);
  assert.equal(isAtOrBefore("2026-10-05T09:00:00Z", "2026-10-05T09:00:00Z"), true);
  assert.equal(isBefore("2026-10-05T09:00:01Z", "2026-10-05T09:00:00Z"), false);
});

test("the manual clock moves only when told", () => {
  const clock = new ManualClock("2026-10-05T09:00:00Z");
  assert.equal(toIso(clock.now()), "2026-10-05T09:00:00.000Z");
  clock.advanceHours(2);
  assert.equal(toIso(clock.now()), "2026-10-05T11:00:00.000Z");
  clock.advanceDays(1);
  clock.advanceMs(500);
  assert.equal(toIso(clock.now()), "2026-10-06T11:00:00.500Z");
  clock.set("2026-01-01T00:00:00Z");
  assert.equal(toIso(clock.now()), "2026-01-01T00:00:00.000Z");
  assert.throws(() => new ManualClock("not a date"), /valid start/);
});
