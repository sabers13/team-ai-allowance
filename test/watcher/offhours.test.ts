import assert from "node:assert/strict";
import { test } from "node:test";
import type { OffHoursPolicy } from "../../src/contracts.ts";
import {
  formatLocal,
  isWorkingTime,
  localParts,
  nextWorkingStart,
  offHoursSegmentStart,
  zonedToUtc,
} from "../../src/watcher/offhours.ts";

const BERLIN = "Europe/Berlin";

function policy(overrides: Partial<OffHoursPolicy> = {}): OffHoursPolicy {
  return {
    enabled: true,
    timeZone: BERLIN,
    workingDays: [1, 2, 3, 4, 5],
    startMinute: 7 * 60,
    endMinute: 19 * 60,
    holidays: [],
    capUsd: 5,
    ...overrides,
  };
}

function at(value: string): Date {
  return new Date(value);
}

test("local parts report the zone weekday, date and minute", () => {
  const parts = localParts(at("2026-10-07T05:00:00Z"), BERLIN);
  assert.equal(parts.dateKey, "2026-10-07");
  assert.equal(parts.weekday, 3);
  assert.equal(parts.minutes, 7 * 60);
});

test("working-window boundaries are inclusive at the start and exclusive at the end", () => {
  const p = policy();
  assert.equal(isWorkingTime(at("2026-10-07T04:59:59Z"), p), false);
  assert.equal(isWorkingTime(at("2026-10-07T05:00:00Z"), p), true);
  assert.equal(isWorkingTime(at("2026-10-07T16:59:59Z"), p), true);
  assert.equal(isWorkingTime(at("2026-10-07T17:00:00Z"), p), false);
});

test("weekends are off-hours", () => {
  const p = policy();
  assert.equal(isWorkingTime(at("2026-10-10T10:00:00Z"), p), false); // Saturday
  assert.equal(isWorkingTime(at("2026-10-11T10:00:00Z"), p), false); // Sunday
});

test("a holiday is off-hours even on a working weekday", () => {
  const p = policy({ holidays: ["2026-10-07"] });
  assert.equal(isWorkingTime(at("2026-10-07T10:00:00Z"), p), false);
  assert.equal(isWorkingTime(at("2026-10-08T10:00:00Z"), p), true);
});

test("the next working start skips the weekend", () => {
  const next = nextWorkingStart(at("2026-10-09T18:00:00Z"), policy());
  assert.equal(next?.toISOString(), "2026-10-12T05:00:00.000Z");
});

test("the DST start week keeps 07:00 local as 05:00 UTC on Monday", () => {
  // Friday 27 Mar 2026 20:00 CET. DST starts Sunday 29 Mar.
  const next = nextWorkingStart(at("2026-03-27T19:00:00Z"), policy());
  assert.equal(next?.toISOString(), "2026-03-30T05:00:00.000Z");
});

test("the DST end week keeps 07:00 local as 06:00 UTC on Monday", () => {
  // Friday 23 Oct 2026 20:00 CEST. DST ends Sunday 25 Oct.
  const next = nextWorkingStart(at("2026-10-23T18:00:00Z"), policy());
  assert.equal(next?.toISOString(), "2026-10-26T06:00:00.000Z");
});

test("a holiday Monday moves the next working start to Tuesday", () => {
  const next = nextWorkingStart(at("2026-10-23T18:00:00Z"), policy({ holidays: ["2026-10-26"] }));
  assert.equal(next?.toISOString(), "2026-10-27T06:00:00.000Z");
});

test("the off-hours segment starts at the end of the last working window", () => {
  const p = policy();
  assert.equal(
    offHoursSegmentStart(at("2026-10-09T18:00:00Z"), p)?.toISOString(),
    "2026-10-09T17:00:00.000Z",
  );
  assert.equal(
    offHoursSegmentStart(at("2026-10-10T10:00:00Z"), p)?.toISOString(),
    "2026-10-09T17:00:00.000Z",
  );
  assert.equal(
    offHoursSegmentStart(at("2026-10-12T04:00:00Z"), p)?.toISOString(),
    "2026-10-09T17:00:00.000Z",
  );
  assert.equal(offHoursSegmentStart(at("2026-10-07T10:00:00Z"), p), null);
});

test("a holiday stretch starts at the previous working window's end", () => {
  const p = policy({ holidays: ["2026-10-12", "2026-10-13"] });
  assert.equal(
    offHoursSegmentStart(at("2026-10-12T12:00:00Z"), p)?.toISOString(),
    "2026-10-09T17:00:00.000Z",
  );
  assert.equal(
    offHoursSegmentStart(at("2026-10-13T12:00:00Z"), p)?.toISOString(),
    "2026-10-09T17:00:00.000Z",
  );
});

test("zonedToUtc round-trips a wall clock across both DST changes", () => {
  assert.equal(zonedToUtc("2026-03-27", 7 * 60, BERLIN).toISOString(), "2026-03-27T06:00:00.000Z");
  assert.equal(zonedToUtc("2026-03-30", 7 * 60, BERLIN).toISOString(), "2026-03-30T05:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-23", 7 * 60, BERLIN).toISOString(), "2026-10-23T05:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-26", 7 * 60, BERLIN).toISOString(), "2026-10-26T06:00:00.000Z");
});

test("formatLocal names the weekday and the local time", () => {
  assert.equal(formatLocal(at("2026-10-12T05:00:00Z"), BERLIN), "Mon 07:00");
  assert.equal(formatLocal(at("2026-10-09T17:00:00Z"), BERLIN), "Fri 19:00");
});

test("a disabled off-hours policy treats every instant as working", () => {
  const p = policy({ enabled: false });
  assert.equal(isWorkingTime(at("2026-10-10T10:00:00Z"), p), true);
  assert.equal(nextWorkingStart(at("2026-10-10T10:00:00Z"), p), null);
  assert.equal(offHoursSegmentStart(at("2026-10-10T10:00:00Z"), p), null);
});

test("an empty working-day list disables the cap instead of blocking forever", () => {
  const p = policy({ workingDays: [] });
  assert.equal(isWorkingTime(at("2026-10-10T10:00:00Z"), p), true);
  assert.equal(nextWorkingStart(at("2026-10-10T10:00:00Z"), p), null);
});
