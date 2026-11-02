/**
 * Period selection for the usage page.
 *
 * Three presets (today, 7 days, 30 days) and a custom `from`/`to` date pair.
 * Dates are local calendar dates in the team's zone, never UTC dates, because
 * a manager reading "today" means the day on their wall.
 */

const DAY_MS = 86_400_000;
export const USAGE_MAX_DAYS = 92;

export type UsagePeriodKey = "today" | "7" | "30" | "custom";

export interface UsagePeriod {
  key: UsagePeriodKey;
  label: string;
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  /** Local calendar days, oldest first, capped at `USAGE_MAX_DAYS`. */
  days: string[];
}

const dateParts = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateParts.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  dateParts.set(timeZone, created);
  return created;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** `YYYY-MM-DD` in the given zone. */
export function dayKey(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the local calendar day starts. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const key = dayKey(date, timeZone);
  const guess = new Date(`${key}T00:00:00.000Z`);
  const first = new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
  return new Date(guess.getTime() - zoneOffsetMs(first, timeZone));
}

/** Add whole local days to a date key. */
export function addDays(key: string, days: number): string {
  const base = new Date(`${key}T12:00:00.000Z`);
  return new Date(base.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function validDateKey(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

function daysBetween(fromDate: string, toDate: string): string[] {
  const days: string[] = [];
  let key = fromDate;
  for (let index = 0; index < USAGE_MAX_DAYS; index += 1) {
    days.push(key);
    if (key === toDate) break;
    key = addDays(key, 1);
  }
  return days;
}

export function usagePeriod(query: URLSearchParams, now: Date, timeZone: string): UsagePeriod {
  const nowKey = dayKey(now, timeZone);
  const customFrom = validDateKey(query.get("from"));
  const customTo = validDateKey(query.get("to"));
  if (customFrom !== null && customTo !== null && customFrom <= customTo) {
    let fromDate = customFrom;
    const toDate = customTo;
    if (daysBetween(fromDate, toDate).length >= USAGE_MAX_DAYS) {
      fromDate = addDays(toDate, -(USAGE_MAX_DAYS - 1));
    }
    const from = startOfLocalDay(new Date(`${fromDate}T12:00:00.000Z`), timeZone);
    const to = new Date(
      startOfLocalDay(new Date(`${addDays(toDate, 1)}T12:00:00.000Z`), timeZone).getTime() - 1,
    );
    return {
      key: "custom",
      label: `${fromDate} to ${toDate}`,
      from,
      to,
      fromDate,
      toDate,
      days: daysBetween(fromDate, toDate),
    };
  }

  const requested = query.get("period");
  if (requested === "today") {
    return {
      key: "today",
      label: "Today",
      from: startOfLocalDay(now, timeZone),
      to: now,
      fromDate: nowKey,
      toDate: nowKey,
      days: [nowKey],
    };
  }
  const dayCount = requested === "7" ? 7 : 30;
  const fromDate = addDays(nowKey, -(dayCount - 1));
  return {
    key: dayCount === 7 ? "7" : "30",
    label: `Last ${dayCount} days`,
    from: startOfLocalDay(new Date(`${fromDate}T12:00:00.000Z`), timeZone),
    to: now,
    fromDate,
    toDate: nowKey,
    days: daysBetween(fromDate, nowKey),
  };
}

/** Period from the console data port's plain query object. */
export function usagePeriodFor(
  query: { period: string | null; from: string | null; to: string | null },
  now: Date,
  timeZone: string,
): UsagePeriod {
  const search = new URLSearchParams();
  if (query.period !== null) search.set("period", query.period);
  if (query.from !== null) search.set("from", query.from);
  if (query.to !== null) search.set("to", query.to);
  return usagePeriod(search, now, timeZone);
}
