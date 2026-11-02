/**
 * CSV export of the usage table. Same rows, same order, same numbers as the
 * page, so a spreadsheet and the screen never disagree.
 */

import { API_FORMAT_LABEL } from "./inference.ts";
import type { UsageReport } from "./report.ts";

const HEADER = [
  "member",
  "member_id",
  "status",
  "requests",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "limit_usd",
  "percent_of_limit",
  "top_model",
  "cli",
  "cli_inferred",
  "api_format",
] as const;

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function usageCsv(report: UsageReport): string {
  const lines = [HEADER.join(",")];
  for (const row of report.rows) {
    lines.push(
      [
        cell(row.displayName),
        cell(row.memberId),
        row.status,
        String(row.requests),
        String(row.inputTokens),
        String(row.outputTokens),
        row.costUsd.toFixed(6),
        row.limitUsd.toFixed(2),
        String(row.percentOfLimit),
        cell(row.topModel),
        cell(row.cli.cli.label),
        "true",
        cell(API_FORMAT_LABEL[row.cli.cli.apiFormat]),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function usageFileName(report: UsageReport): string {
  return `usage-${report.period.fromDate}-to-${report.period.toDate}.csv`;
}
