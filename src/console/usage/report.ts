/**
 * Aggregation for the usage page: one report from the rows the control service
 * returned, the members in scope, the model catalogue and the chosen period.
 *
 * This module is pure. It never reads the clock, the store or the network, so
 * the same rows always produce the same report and the tests can pin every
 * number. The adapter in `src/server/console.ts` does the reads; the page and
 * the CSV export render the report.
 */

import type { ModelEntry, Status, UsageRow } from "../../contracts.ts";
import { type CliSummary, inferCli, summarizeCli } from "./inference.ts";
import { dayKey, type UsagePeriod, usagePeriod } from "./period.ts";

export type UsageSeries = "member" | "model";
export type UsageSortKey =
  | "name"
  | "status"
  | "requests"
  | "input"
  | "output"
  | "cost"
  | "percent"
  | "topModel"
  | "cli";

export const USAGE_SORT_KEYS: readonly UsageSortKey[] = [
  "name",
  "status",
  "requests",
  "input",
  "output",
  "cost",
  "percent",
  "topModel",
  "cli",
];

export interface UsageQuery {
  period: string | null;
  from: string | null;
  to: string | null;
  series: string | null;
  sort: string | null;
  dir: string | null;
}

export function parseUsageQuery(query: URLSearchParams): UsageQuery {
  return {
    period: query.get("period"),
    from: query.get("from"),
    to: query.get("to"),
    series: query.get("series"),
    sort: query.get("sort"),
    dir: query.get("dir"),
  };
}

export function seriesOf(query: UsageQuery): UsageSeries {
  return query.series === "model" ? "model" : "member";
}

export function sortOf(query: UsageQuery): { key: UsageSortKey; direction: "asc" | "desc" } {
  const key = USAGE_SORT_KEYS.includes(query.sort as UsageSortKey)
    ? (query.sort as UsageSortKey)
    : "cost";
  const direction = query.dir === "asc" ? "asc" : "desc";
  return { key, direction };
}

export interface UsageMember {
  id: string;
  displayName: string;
  status: Status;
  /** The member's effective budget for their own period. */
  limitUsd: number;
}

export interface UsageReportInput {
  query: UsageQuery;
  now: Date;
  timeZone: string;
  scopeLabel: string;
  members: readonly UsageMember[];
  models: readonly ModelEntry[];
  usage: readonly UsageRow[];
}

export interface UsageMemberRow {
  memberId: string;
  displayName: string;
  status: Status;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd: number;
  percentOfLimit: number;
  topModel: string;
  topModelId: string | null;
  cli: CliSummary;
}

export interface UsageSeriesRow {
  key: string;
  label: string;
  tone: "accent" | "ok" | "soft" | "grace" | "blocked" | "muted";
  costUsd: number;
  /** Per-day cost, aligned with `days`. */
  values: number[];
}

export interface UsageReport {
  scopeLabel: string;
  period: UsagePeriod;
  series: UsageSeries;
  sort: { key: UsageSortKey; direction: "asc" | "desc" };
  rows: UsageMemberRow[];
  days: string[];
  seriesRows: UsageSeriesRow[];
  totalRequests: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const TONES = ["accent", "ok", "soft", "grace", "blocked", "muted"] as const;

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function inPeriod(row: UsageRow, period: UsagePeriod): boolean {
  const at = Date.parse(row.at);
  return at >= period.from.getTime() && at <= period.to.getTime();
}

function topModelOf(
  rows: readonly UsageRow[],
  modelNames: ReadonlyMap<string, string>,
): { id: string | null; label: string } {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.modelId, (totals.get(row.modelId) ?? 0) + row.costUsd);
  let bestId: string | null = null;
  let bestCost = -1;
  for (const [modelId, cost] of totals) {
    if (cost > bestCost) {
      bestId = modelId;
      bestCost = cost;
    }
  }
  if (bestId === null) return { id: null, label: "—" };
  return { id: bestId, label: modelNames.get(bestId) ?? bestId };
}

function sortRows(
  rows: UsageMemberRow[],
  sort: { key: UsageSortKey; direction: "asc" | "desc" },
): UsageMemberRow[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  const value = (row: UsageMemberRow): number | string => {
    switch (sort.key) {
      case "name":
        return row.displayName.toLocaleLowerCase();
      case "status":
        return { ok: 0, soft: 1, grace: 2, blocked: 3 }[row.status];
      case "requests":
        return row.requests;
      case "input":
        return row.inputTokens;
      case "output":
        return row.outputTokens;
      case "cost":
        return row.costUsd;
      case "percent":
        return row.percentOfLimit;
      case "topModel":
        return row.topModel.toLocaleLowerCase();
      case "cli":
        return row.cli.cli.label.toLocaleLowerCase();
    }
  };
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const compared =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), "en");
    if (compared !== 0) return compared * factor;
    return (
      left.displayName.localeCompare(right.displayName, "en") ||
      left.memberId.localeCompare(right.memberId)
    );
  });
}

export function buildUsageReport(input: UsageReportInput): UsageReport {
  const search = new URLSearchParams();
  if (input.query.period !== null) search.set("period", input.query.period);
  if (input.query.from !== null) search.set("from", input.query.from);
  if (input.query.to !== null) search.set("to", input.query.to);
  const period = usagePeriod(search, input.now, input.timeZone);
  const series = seriesOf(input.query);
  const sort = sortOf(input.query);
  const modelNames = new Map(input.models.map((model) => [model.id, model.displayName]));

  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const rowsByMember = new Map<string, UsageRow[]>();
  for (const row of input.usage) {
    if (!inPeriod(row, period)) continue;
    if (!membersById.has(row.memberId)) continue;
    const list = rowsByMember.get(row.memberId) ?? [];
    list.push(row);
    rowsByMember.set(row.memberId, list);
  }

  const rows: UsageMemberRow[] = [];
  for (const member of input.members) {
    const memberRows = rowsByMember.get(member.id) ?? [];
    const costUsd = round(memberRows.reduce((sum, row) => sum + row.costUsd, 0));
    const top = topModelOf(memberRows, modelNames);
    rows.push({
      memberId: member.id,
      displayName: member.displayName,
      status: member.status,
      requests: memberRows.length,
      inputTokens: memberRows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: memberRows.reduce((sum, row) => sum + row.outputTokens, 0),
      costUsd,
      limitUsd: member.limitUsd,
      percentOfLimit: member.limitUsd <= 0 ? 0 : Math.round((costUsd / member.limitUsd) * 100),
      topModel: top.label,
      topModelId: top.id,
      cli: summarizeCli(memberRows),
    });
  }

  const dayIndex = new Map(period.days.map((day, index) => [day, index]));
  const seriesRows: UsageSeriesRow[] = [];
  if (series === "member") {
    for (const member of input.members) {
      const memberRows = rowsByMember.get(member.id) ?? [];
      const costUsd = round(memberRows.reduce((sum, row) => sum + row.costUsd, 0));
      const values = period.days.map(() => 0);
      for (const row of memberRows) {
        const index = dayIndex.get(dayKey(new Date(row.at), input.timeZone));
        if (index === undefined) continue;
        values[index] = round((values[index] ?? 0) + row.costUsd);
      }
      seriesRows.push({
        key: member.id,
        label: member.displayName,
        tone: TONES[seriesRows.length % TONES.length] ?? "muted",
        costUsd,
        values,
      });
    }
  } else {
    const byModel = new Map<string, UsageRow[]>();
    for (const memberRows of rowsByMember.values()) {
      for (const row of memberRows) {
        const list = byModel.get(row.modelId) ?? [];
        list.push(row);
        byModel.set(row.modelId, list);
      }
    }
    for (const [modelId, modelRows] of byModel) {
      const values = period.days.map(() => 0);
      for (const row of modelRows) {
        const index = dayIndex.get(dayKey(new Date(row.at), input.timeZone));
        if (index === undefined) continue;
        values[index] = round((values[index] ?? 0) + row.costUsd);
      }
      seriesRows.push({
        key: modelId,
        label: modelNames.get(modelId) ?? modelId,
        tone: TONES[seriesRows.length % TONES.length] ?? "muted",
        costUsd: round(modelRows.reduce((sum, row) => sum + row.costUsd, 0)),
        values,
      });
    }
  }
  seriesRows.sort(
    (left, right) => right.costUsd - left.costUsd || left.label.localeCompare(right.label),
  );

  const sortedRows = sortRows(rows, sort);
  const chartRows = seriesRows.filter((row) => row.costUsd > 0);
  return {
    scopeLabel: input.scopeLabel,
    period,
    series,
    sort,
    rows: sortedRows,
    days: period.days,
    seriesRows: chartRows,
    totalRequests: rows.reduce((sum, row) => sum + row.requests, 0),
    totalCostUsd: round(rows.reduce((sum, row) => sum + row.costUsd, 0)),
    totalInputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
  };
}

export { inferCli };
