import type { Thresholds, Usd } from "../contracts.ts";
import { hardLimitUsd } from "../core/policy.ts";

/**
 * Pure cap and alert math. No clock, no store, no network.
 *
 * A threshold fires at most once per period; the watcher supplies the period
 * start as part of the dedupe key. The unusual-spend rule:
 * today is more than three times the member's 14-day median and at least the
 * team's minimum.
 */

export type ThresholdKind = "soft_limit" | "grace" | "hard_limit";

const EPSILON = 1e-9;

/** Every threshold the spend has reached, hardest first. */
export function reachedThresholds(
  spendUsd: Usd,
  budgetUsd: Usd,
  thresholds: Thresholds,
): ThresholdKind[] {
  const reached: ThresholdKind[] = [];
  const hard = hardLimitUsd(budgetUsd, thresholds);
  if (spendUsd + EPSILON >= hard) reached.push("hard_limit");
  if (spendUsd + EPSILON >= budgetUsd) reached.push("grace");
  if (spendUsd + EPSILON >= budgetUsd * thresholds.softRatio) reached.push("soft_limit");
  return reached;
}

export function thresholdDedupeKey(
  memberId: string,
  kind: ThresholdKind,
  periodStartIso: string,
): string {
  return `threshold:${memberId}:${kind}:${periodStartIso}`;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** `max(3 × median, minimum)`; exposed so a notice can state the threshold. */
export function unusualSpendThreshold(previousDailyUsd: readonly number[], minUsd: Usd): Usd {
  return Math.max(minUsd, 3 * median(previousDailyUsd));
}

export function unusualSpendTrigger(
  todayUsd: Usd,
  previousDailyUsd: readonly number[],
  minUsd: Usd,
): boolean {
  if (todayUsd <= 0) return false;
  return todayUsd + EPSILON > unusualSpendThreshold(previousDailyUsd, minUsd);
}

export function unusualDedupeKey(memberId: string, dayKey: string): string {
  return `unusual:${memberId}:${dayKey}`;
}

export type WatcherBlockKind = "off_hours" | "token_cap";

/**
 * A watcher block is recoverable: the reason carries the kind and the instant
 * at which the watcher may unblock. Manager blocks use their own plain reason
 * and are never touched by this parser.
 */
export function watcherBlockReason(kind: WatcherBlockKind, detail: string, until: Date): string {
  const label = kind === "off_hours" ? "off-hours cap reached" : "token cap reached";
  return `${label}: ${detail} [taa-watcher kind=${kind} until=${until.toISOString()}]`;
}

export function parseWatcherBlockReason(
  reason: string | null,
): { kind: WatcherBlockKind; until: Date } | null {
  if (reason === null) return null;
  const match = /\[taa-watcher kind=(off_hours|token_cap) until=([^\]]+)\]$/u.exec(reason);
  if (match === null) return null;
  const until = new Date(match[2] ?? "");
  if (Number.isNaN(until.getTime())) return null;
  return { kind: match[1] === "off_hours" ? "off_hours" : "token_cap", until };
}

export function offHoursDedupeKey(memberId: string, segmentStartIso: string): string {
  return `off_hours:${memberId}:${segmentStartIso}`;
}

export function tokenCapDedupeKey(memberId: string, periodStartIso: string): string {
  return `token_cap:${memberId}:${periodStartIso}`;
}

export function formatUsd(value: Usd): string {
  return `USD ${value.toFixed(2)}`;
}
