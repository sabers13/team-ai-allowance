/**
 * The watcher's configuration module.
 *
 * `TAA_WATCH_INTERVAL_MS` is the poll interval, default 30 s. The poll asks for
 * a 60-second overlap and de-duplicates by request id, so a slow gateway never
 * loses a row and a repeated row is ignored.
 */

export const DEFAULT_WATCH_INTERVAL_MS = 30_000;
export const POLL_OVERLAP_MS = 60_000;
export const DEFAULT_PUBLIC_URL = "http://localhost:18080";

export interface WatcherConfig {
  intervalMs: number;
  overlapMs: number;
  publicUrl: string;
}

function parseInterval(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_WATCH_INTERVAL_MS;
  return parsed;
}

function cleanUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return DEFAULT_PUBLIC_URL;
  return trimmed.replace(/\/+$/u, "");
}

export function loadWatcherConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  return {
    intervalMs: parseInterval(env.TAA_WATCH_INTERVAL_MS),
    overlapMs: POLL_OVERLAP_MS,
    publicUrl: cleanUrl(env.TAA_PUBLIC_URL),
  };
}
