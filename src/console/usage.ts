/**
 * Turn usage rows into the 30-day series the chart draws.
 *
 * Rows are grouped by the team's calendar day; the three models with the most
 * spend get a line, and every line carries its own dash pattern so a greyscale
 * print still distinguishes them.
 */

import type { ModelEntry, UsageRow } from "../contracts.ts";
import type { ChartSeries } from "./chart.ts";
import { shortDate } from "./format.ts";

const TONES = ["accent", "ok", "soft", "grace", "blocked", "muted"] as const;
const DASHES = ["", "4 4", "1 3", "6 2 1 2", "2 4", "5 3"];

export interface DailySeries {
  labels: string[];
  series: ChartSeries[];
  isoDays: string[];
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function dailySeries(
  usage: UsageRow[],
  models: ModelEntry[],
  now: Date,
  timeZone: string,
  days = 30,
): DailySeries {
  const isoDays: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 86_400_000);
    isoDays.push(date.toISOString().slice(0, 10));
  }

  const totals = new Map<string, number>();
  for (const row of usage) {
    totals.set(row.modelId, (totals.get(row.modelId) ?? 0) + row.costUsd);
  }
  const topModels = [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([modelId]) => modelId);

  const series = topModels.map((modelId, index) => {
    const values = isoDays.map((day) =>
      Number(
        usage
          .filter((row) => row.modelId === modelId && dayKey(row.at) === day)
          .reduce((sum, row) => sum + row.costUsd, 0)
          .toFixed(2),
      ),
    );
    const label = models.find((model) => model.id === modelId)?.displayName ?? modelId;
    return {
      id: modelId,
      label,
      tone: TONES[index % TONES.length] ?? "muted",
      dash: DASHES[index % DASHES.length] ?? "",
      values,
    };
  });

  return {
    labels: isoDays.map((day) => shortDate(`${day}T12:00:00Z`, timeZone)),
    series,
    isoDays,
  };
}

export function sumUsage(usage: UsageRow[]): number {
  return Number(usage.reduce((sum, row) => sum + row.costUsd, 0).toFixed(2));
}
