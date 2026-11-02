/**
 * Display formatting. Every number that reaches a page goes through here so
 * money always has two decimals and times always carry the team's zone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const existing = formatters.get(key);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
  formatters.set(key, created);
  return created;
}

export function usd(value: number): string {
  return `USD ${value.toFixed(2)}`;
}

/** Money without the currency prefix, for dense table cells. */
export function money(value: number): string {
  return value.toFixed(2);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export function percentText(part: number, whole: number): string {
  return `${percent(part, whole)}%`;
}

export function dateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return dateFormatter(timeZone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: false,
  }).format(date);
}

export function dateOnly(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return dateFormatter(timeZone, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function shortDate(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return dateFormatter(timeZone, { day: "numeric", month: "short" }).format(date);
}

export function timeOnly(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return dateFormatter(timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: false,
  }).format(date);
}

export function zoneAbbreviation(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateFormatter(timeZone, { timeZoneName: "short" }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

export function dateInputValue(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateFormatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function relative(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const future = seconds < 0;
  const magnitude = Math.abs(seconds);
  const text = (() => {
    if (magnitude < 60) return "a moment";
    if (magnitude < 3600) return `${Math.round(magnitude / 60)} min`;
    if (magnitude < 86_400) return `${Math.round(magnitude / 3600)} h`;
    return `${Math.round(magnitude / 86_400)} d`;
  })();
  return future ? `in ${text}` : `${text} ago`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function truncate(text: string, max: number): string {
  const clean = text.replaceAll(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function minutesOfDay(minutes: number): string {
  const safe = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayList(days: number[]): string {
  if (days.length === 7) return "Every day";
  return days
    .map((day) => WEEKDAYS[day - 1])
    .filter((name): name is string => name !== undefined)
    .join(", ");
}

export function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
