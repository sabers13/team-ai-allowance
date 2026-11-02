import type {
  GatewaySpendRow,
  KeyHash,
  Limits,
  Member,
  TeamPolicy,
  UsageRow,
  Usd,
} from "../contracts.ts";
import { periodEnd, periodStart, toIso } from "../core/time.ts";
import { isWorkingTime, localParts, offHoursSegmentStart, shiftDateKey } from "./offhours.ts";

/**
 * Spend polling and aggregation.
 *
 * The gateway returns spend rows with a key hash. Here they become `UsageRow`s
 * tied to a member, then aggregates per member, model and local day. Off-hours
 * cost is tracked separately because it drives its own cap.
 */

export const UNUSUAL_WINDOW_DAYS = 14;

export function toUsageRows(
  spend: readonly GatewaySpendRow[],
  membersByHash: ReadonlyMap<KeyHash, Member>,
): UsageRow[] {
  const rows: UsageRow[] = [];
  const seen = new Set<string>();
  for (const entry of spend) {
    if (seen.has(entry.requestId)) continue;
    const member = membersByHash.get(entry.keyHash);
    if (member === undefined) continue;
    seen.add(entry.requestId);
    rows.push({
      id: `use_${entry.requestId}`,
      memberId: member.id,
      modelId: entry.model,
      at: entry.endedAt ?? entry.startedAt,
      inputTokens: entry.promptTokens,
      outputTokens: entry.completionTokens,
      costUsd: entry.spendUsd,
      requestId: entry.requestId,
      ...(entry.apiFormat === undefined ? {} : { apiFormat: entry.apiFormat }),
    });
  }
  return rows;
}

export interface UsageAggregate {
  memberId: string;
  modelId: string;
  /** Local calendar day in the team's zone. */
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: Usd;
  offHoursCostUsd: Usd;
}

/** Per member, model and local day, with off-hours cost separated. */
export function aggregateUsage(
  rows: readonly UsageRow[],
  policy: TeamPolicy,
  now: Date,
): UsageAggregate[] {
  const byKey = new Map<string, UsageAggregate>();
  for (const row of rows) {
    if (new Date(row.at).getTime() > now.getTime()) continue;
    const day = localParts(new Date(row.at), policy.offHours.timeZone).dateKey;
    const key = `${row.memberId}\u0000${row.modelId}\u0000${day}`;
    let aggregate = byKey.get(key);
    if (aggregate === undefined) {
      aggregate = {
        memberId: row.memberId,
        modelId: row.modelId,
        day,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        offHoursCostUsd: 0,
      };
      byKey.set(key, aggregate);
    }
    aggregate.requests += 1;
    aggregate.inputTokens += row.inputTokens;
    aggregate.outputTokens += row.outputTokens;
    aggregate.totalTokens += row.inputTokens + row.outputTokens;
    aggregate.costUsd += row.costUsd;
    if (!isWorkingTime(new Date(row.at), policy.offHours)) {
      aggregate.offHoursCostUsd += row.costUsd;
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.memberId.localeCompare(b.memberId) ||
      a.day.localeCompare(b.day) ||
      a.modelId.localeCompare(b.modelId),
  );
}

/** Aggregate by member and local day, the shape the unusual-spend rule needs. */
export function dailyTotals(
  rows: readonly UsageRow[],
  policy: TeamPolicy,
  now: Date,
): Map<string, Map<string, number>> {
  const totals = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (new Date(row.at).getTime() > now.getTime()) continue;
    const day = localParts(new Date(row.at), policy.offHours.timeZone).dateKey;
    let days = totals.get(row.memberId);
    if (days === undefined) {
      days = new Map<string, number>();
      totals.set(row.memberId, days);
    }
    days.set(day, (days.get(day) ?? 0) + row.costUsd);
  }
  return totals;
}

export interface UsageSnapshot {
  periodStartIso: string;
  periodEndIso: string;
  periodSpendUsd: Usd;
  periodTokens: number;
  todayKey: string;
  todaySpendUsd: Usd;
  /** Oldest to newest, exactly `UNUSUAL_WINDOW_DAYS` values, missing days as 0. */
  previousDailyUsd: Usd[];
  offHoursSpendUsd: Usd;
  offHoursSegmentStartIso: string | null;
}

/**
 * Everything a cap needs from one member's usage. The caller passes rows from
 * at least `min(period start, 15 days ago)` so no branch recomputes a query.
 */
export function usageSnapshot(input: {
  rows: readonly UsageRow[];
  policy: TeamPolicy;
  limits: Limits;
  now: Date;
}): UsageSnapshot {
  const { rows, policy, limits, now } = input;
  const start = periodStart(limits.period, now);
  const end = periodEnd(limits.period, now);
  const startTime = start.getTime();
  const nowTime = now.getTime();
  const todayKey = localParts(now, policy.offHours.timeZone).dateKey;

  let periodSpendUsd = 0;
  let periodTokens = 0;
  let todaySpendUsd = 0;
  const totals = new Map<string, number>();
  for (const row of rows) {
    const at = new Date(row.at).getTime();
    if (Number.isNaN(at) || at > nowTime) continue;
    const day = localParts(new Date(row.at), policy.offHours.timeZone).dateKey;
    totals.set(day, (totals.get(day) ?? 0) + row.costUsd);
    if (at >= startTime) {
      periodSpendUsd += row.costUsd;
      periodTokens += row.inputTokens + row.outputTokens;
    }
    if (day === todayKey) todaySpendUsd += row.costUsd;
  }

  const previousDailyUsd: Usd[] = [];
  for (let offset = UNUSUAL_WINDOW_DAYS; offset >= 1; offset -= 1) {
    previousDailyUsd.push(totals.get(shiftDateKey(todayKey, -offset)) ?? 0);
  }

  const segmentStart = offHoursSegmentStart(now, policy.offHours);
  let offHoursSpendUsd = 0;
  if (segmentStart !== null) {
    const segmentTime = segmentStart.getTime();
    for (const row of rows) {
      const at = new Date(row.at).getTime();
      if (at >= segmentTime && at <= nowTime) offHoursSpendUsd += row.costUsd;
    }
  }

  return {
    periodStartIso: toIso(start),
    periodEndIso: toIso(end),
    periodSpendUsd,
    periodTokens,
    todayKey,
    todaySpendUsd,
    previousDailyUsd,
    offHoursSpendUsd,
    offHoursSegmentStartIso: segmentStart === null ? null : toIso(segmentStart),
  };
}
