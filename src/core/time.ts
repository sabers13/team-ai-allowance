import type { IsoDateTime, Period } from "../contracts.ts";
import { invalidInput } from "./errors.ts";

/**
 * Time helpers shared by the core.
 *
 * Periods are calendar periods in UTC: a day starts at 00:00 UTC, a week on
 * Monday 00:00 UTC, a month on the first at 00:00 UTC. The team's own zone is
 * used by the watcher for working hours; budgets keep one clock so a grant
 * expiry never depends on a DST jump.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function toIso(at: Date): IsoDateTime {
  return at.toISOString();
}

export function fromIso(value: IsoDateTime): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    invalidInput("Not a valid ISO 8601 instant.");
  }
  return parsed;
}

/** Parse an instant that must carry an explicit offset or `Z`. */
export function parseInstant(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    invalidInput("Expected an ISO 8601 instant with an explicit offset.");
  }
  return fromIso(value);
}

/**
 * Parse a manager's `until` value. A plain date means the end of that day in
 * UTC, so "until 2 Nov" still covers the whole of 2 Nov.
 */
export function parseUntil(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59.999Z`);
  }
  return parseInstant(value);
}

export function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * HOUR_MS);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

export function startOfDayUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Monday 00:00 UTC of the ISO week containing `at`. */
export function startOfWeekUtc(at: Date): Date {
  const day = startOfDayUtc(at);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

export function startOfMonthUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function periodStart(period: Period, at: Date): Date {
  switch (period) {
    case "daily":
      return startOfDayUtc(at);
    case "weekly":
      return startOfWeekUtc(at);
    case "monthly":
      return startOfMonthUtc(at);
  }
}

/** Exclusive end of the period: the start of the next one. */
export function periodEnd(period: Period, at: Date): Date {
  switch (period) {
    case "daily": {
      const start = startOfDayUtc(at);
      return new Date(start.getTime() + DAY_MS);
    }
    case "weekly": {
      const start = startOfWeekUtc(at);
      return new Date(start.getTime() + 7 * DAY_MS);
    }
    case "monthly": {
      const start = startOfMonthUtc(at);
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    }
  }
}

export function isBefore(a: IsoDateTime, b: IsoDateTime): boolean {
  return fromIso(a).getTime() < fromIso(b).getTime();
}

export function isAtOrBefore(a: IsoDateTime, b: IsoDateTime): boolean {
  return fromIso(a).getTime() <= fromIso(b).getTime();
}
