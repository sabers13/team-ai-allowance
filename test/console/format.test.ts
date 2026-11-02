import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dateInputValue,
  dateTime,
  initials,
  minutesOfDay,
  percent,
  plural,
  relative,
  truncate,
  usd,
  weekdayList,
} from "../../src/console/format.ts";

test("money always has two decimals", () => {
  assert.equal(usd(5), "USD 5.00");
  assert.equal(usd(0.5), "USD 0.50");
  assert.equal(usd(1234.567), "USD 1234.57");
});

test("percent rounds and never divides by zero", () => {
  assert.equal(percent(16.8, 20), 84);
  assert.equal(percent(1, 0), 0);
});

test("times carry the team zone and an ISO title exists separately", () => {
  const shown = dateTime("2026-10-31T09:15:00Z", "Europe/Berlin");
  assert.equal(shown.includes("2026"), true);
  assert.equal(shown.includes("10:15"), true);
  assert.match(shown, /CET|GMT\+1/);
});

test("date input values are YYYY-MM-DD in the team zone", () => {
  assert.equal(dateInputValue("2026-10-31T23:30:00Z", "Europe/Berlin"), "2026-11-01");
});

test("relative time reads forward and backward", () => {
  const now = new Date("2026-10-31T10:00:00Z");
  assert.equal(relative("2026-10-31T09:00:00Z", now), "1 h ago");
  assert.equal(relative("2026-10-31T10:30:00Z", now), "in 30 min");
});

test("initials and truncation", () => {
  assert.equal(initials("Lena Park"), "LP");
  assert.equal(initials("Mira"), "M");
  assert.equal(truncate("a".repeat(20), 10).length, 10);
  assert.equal(truncate("short", 10), "short");
});

test("time and weekday helpers", () => {
  assert.equal(minutesOfDay(540), "09:00");
  assert.equal(minutesOfDay(1080), "18:00");
  assert.equal(weekdayList([1, 2, 3, 4, 5]), "Mon, Tue, Wed, Thu, Fri");
  assert.equal(weekdayList([1, 2, 3, 4, 5, 6, 7]), "Every day");
  assert.equal(plural(1, "request", "requests"), "request");
  assert.equal(plural(2, "request", "requests"), "requests");
});
