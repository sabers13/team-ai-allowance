/**
 * Public entry point for the watcher module.
 *
 * `taa serve` constructs `Watcher` with the store, gateway and clock, then
 * calls `start()`. Tests drive `tick()` with a fake clock.
 */

export type {
  ThresholdKind,
  WatcherBlockKind,
} from "./caps.ts";
export {
  formatUsd,
  median,
  offHoursDedupeKey,
  parseWatcherBlockReason,
  reachedThresholds,
  thresholdDedupeKey,
  tokenCapDedupeKey,
  unusualDedupeKey,
  unusualSpendThreshold,
  unusualSpendTrigger,
  watcherBlockReason,
} from "./caps.ts";
export type { WatcherConfig } from "./config.ts";
export {
  DEFAULT_PUBLIC_URL,
  DEFAULT_WATCH_INTERVAL_MS,
  loadWatcherConfig,
  POLL_OVERLAP_MS,
} from "./config.ts";
export type { LocalParts } from "./offhours.ts";
export {
  formatLocal,
  isWorkingTime,
  localParts,
  nextWorkingStart,
  offHoursSegmentStart,
  shiftDateKey,
  zonedToUtc,
} from "./offhours.ts";
export type { UsageAggregate, UsageSnapshot } from "./spend.ts";
export {
  aggregateUsage,
  dailyTotals,
  toUsageRows,
  UNUSUAL_WINDOW_DAYS,
  usageSnapshot,
} from "./spend.ts";
export type { WatcherDeps, WatchResult } from "./watcher.ts";
export { WATCHER_ACTOR, WATCHER_AUDIT, Watcher } from "./watcher.ts";
