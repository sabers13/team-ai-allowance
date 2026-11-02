import type { OffHoursPolicy } from "../contracts.ts";

/**
 * Working-hours math for the off-hours cap.
 *
 * All comparisons happen in the team's IANA zone, so a DST week (23 or 25 hour
 * days) and a holiday list both behave. Nothing here reads a clock: callers
 * pass the instant, which keeps the tests on a fake clock deterministic.
 */

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: Monday = 1 ... Sunday = 7. */
  weekday: number;
  /** `YYYY-MM-DD` in the zone. */
  dateKey: string;
  /** Minutes from local midnight. */
  minutes: number;
}

function resolveZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const zone = resolveZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "0";

  const year = Number.parseInt(value("year"), 10);
  const month = Number.parseInt(value("month"), 10);
  const day = Number.parseInt(value("day"), 10);
  const hour = Number.parseInt(value("hour"), 10);
  const minute = Number.parseInt(value("minute"), 10);
  const second = Number.parseInt(value("second"), 10);
  const weekdayName = value("weekday");
  const weekdayIndex = WEEKDAY_NAMES.indexOf(weekdayName as (typeof WEEKDAY_NAMES)[number]);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: weekdayIndex < 0 ? 1 : weekdayIndex === 0 ? 7 : weekdayIndex,
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
  };
}

/** Milliseconds the zone is ahead of UTC at `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = localParts(at, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - at.getTime();
}

/** Convert a wall-clock date and minute in `timeZone` to the UTC instant. */
export function zonedToUtc(dateKey: string, minutes: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map((value) => Number.parseInt(value, 10));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const desired = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour, minute, 0);
  let guess = desired;
  // Two passes settle the offset across a DST boundary.
  for (let pass = 0; pass < 3; pass += 1) {
    const offset = zoneOffsetMs(new Date(guess), timeZone);
    const next = desired - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map((value) => Number.parseInt(value, 10));
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

function weekdayOfDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map((value) => Number.parseInt(value, 10));
  const index = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return index === 0 ? 7 : index;
}

function isWorkingDate(policy: OffHoursPolicy, dateKey: string): boolean {
  if (policy.holidays.includes(dateKey)) return false;
  return policy.workingDays.includes(weekdayOfDateKey(dateKey));
}

/** True when the instant is inside the team's working window. */
export function isWorkingTime(at: Date, policy: OffHoursPolicy): boolean {
  if (!policy.enabled || policy.workingDays.length === 0) return true;
  const local = localParts(at, policy.timeZone);
  if (!isWorkingDate(policy, local.dateKey)) return false;
  return local.minutes >= policy.startMinute && local.minutes < policy.endMinute;
}

/**
 * Start of the next working window strictly after `at`, or null when the
 * policy has no working days at all.
 */
export function nextWorkingStart(at: Date, policy: OffHoursPolicy): Date | null {
  if (!policy.enabled || policy.workingDays.length === 0) return null;
  const local = localParts(at, policy.timeZone);
  for (let offset = 0; offset <= 60; offset += 1) {
    const dateKey = shiftDateKey(local.dateKey, offset);
    if (!isWorkingDate(policy, dateKey)) continue;
    const start = zonedToUtc(dateKey, policy.startMinute, policy.timeZone);
    if (start.getTime() > at.getTime()) return start;
  }
  return null;
}

/**
 * Start of the current off-hours stretch (the last working window's end), or
 * null when the instant is inside working hours.
 */
export function offHoursSegmentStart(at: Date, policy: OffHoursPolicy): Date | null {
  if (!policy.enabled || policy.workingDays.length === 0) return null;
  if (isWorkingTime(at, policy)) return null;
  const local = localParts(at, policy.timeZone);
  for (let offset = 0; offset <= 60; offset += 1) {
    const dateKey = shiftDateKey(local.dateKey, -offset);
    if (!isWorkingDate(policy, dateKey)) continue;
    const end = zonedToUtc(dateKey, policy.endMinute, policy.timeZone);
    if (end.getTime() <= at.getTime()) return end;
  }
  return null;
}

/** `Mon 07:00` in the team zone, for a person reading a notice. */
export function formatLocal(at: Date, timeZone: string): string {
  const local = localParts(at, timeZone);
  const weekday = WEEKDAY_NAMES[local.weekday === 7 ? 0 : local.weekday] ?? "Mon";
  const hour = String(local.hour).padStart(2, "0");
  const minute = String(local.minute).padStart(2, "0");
  return `${weekday} ${hour}:${minute}`;
}
