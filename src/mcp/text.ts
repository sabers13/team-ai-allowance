/**
 * Short plain-text summaries for allowance answers. One module renders them
 * for both the MCP tools and the `taa` CLI so the wording never drifts.
 */

import type { EffectivePolicy, Request, UsageRow } from "../contracts.ts";

export function formatUsd(amount: number): string {
  return `USD ${amount.toFixed(2)}`;
}

export interface AllowanceView {
  readonly remainingUsd: number;
  readonly budgetUsd: number;
  readonly spendUsd: number;
  readonly status: string;
  readonly periodEndsAt: string | null;
  readonly allowedModels: string[];
}

/** One short paragraph: what is left, the status, and what may be used. */
export function formatAllowance(view: AllowanceView): string {
  const percent = view.budgetUsd > 0 ? Math.round((view.spendUsd / view.budgetUsd) * 100) : 0;
  const models = view.allowedModels.length > 0 ? view.allowedModels.join(", ") : "none";
  const reset = view.periodEndsAt !== null ? ` Resets ${view.periodEndsAt}.` : "";
  return (
    `${formatUsd(view.remainingUsd)} left of ${formatUsd(view.budgetUsd)} this period ` +
    `(${percent}% used, ${view.status} limit). Allowed: ${models}.${reset}`
  );
}

export function allowanceView(policy: EffectivePolicy, spendUsd: number): AllowanceView {
  return {
    remainingUsd: Math.max(0, policy.effectiveBudgetUsd - spendUsd),
    budgetUsd: policy.effectiveBudgetUsd,
    spendUsd,
    status: policy.status,
    periodEndsAt: null,
    allowedModels: [...policy.allowedModels],
  };
}

/** One line per request: id, kind, amount or model, state. */
export function formatRequests(requests: readonly Request[]): string {
  if (requests.length === 0) return "No requests.";
  return requests
    .map((request) => {
      const what =
        request.kind === "more_budget" && request.amountUsd !== null
          ? formatUsd(request.amountUsd)
          : (request.modelId ?? request.kind);
      return `${request.id} ${request.kind} ${what} — ${request.state}`;
    })
    .join("\n");
}

/** Spend grouped by model, newest totals first. */
export function summarizeUsage(
  rows: readonly UsageRow[],
): Array<{ modelId: string; spendUsd: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.modelId, (totals.get(row.modelId) ?? 0) + row.costUsd);
  return [...totals.entries()]
    .map(([modelId, spendUsd]) => ({ modelId, spendUsd }))
    .sort((a, b) => b.spendUsd - a.spendUsd);
}
