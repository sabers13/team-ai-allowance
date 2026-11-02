/**
 * Status vocabulary shared by the pills, the tables and the request cards.
 *
 * Four status tones with explicit text labels so the
 * label is never carried by colour alone.
 */

import type { EffectivePolicy, Limits, Status } from "../contracts.ts";
import { percent, percentText, usd } from "./format.ts";

export type Tone = Status | "neutral" | "accent";

export interface StatusView {
  tone: Tone;
  label: string;
  title: string;
  /** Spoken form for the row or card, for example "Soft limit, 84% of USD 20.00". */
  description: string;
}

const LABELS: Readonly<Record<Status, string>> = {
  ok: "OK",
  soft: "Soft limit",
  grace: "Grace",
  blocked: "Blocked",
};

export function statusOf(policy: EffectivePolicy): Status {
  return policy.status;
}

export function statusView(policy: EffectivePolicy, spendUsd: number): StatusView {
  const limit = policy.effectiveBudgetUsd;
  const title = `${percentText(spendUsd, limit)} of ${usd(limit)}`;
  const offHours =
    policy.blocked && policy.blockedReason !== null && isOffHoursReason(policy.blockedReason);
  if (offHours) {
    return {
      tone: "blocked",
      label: "Blocked",
      title: policy.blockedReason ?? title,
      description: `Blocked for off-hours spend, ${title}`,
    };
  }
  return {
    tone: policy.status,
    label: LABELS[policy.status],
    title,
    description: `${LABELS[policy.status]}, ${title}`,
  };
}

export function isOffHoursReason(reason: string): boolean {
  return /off.?hours/i.test(reason);
}

export function statusToneForCount(blocked: number): Tone {
  return blocked > 0 ? "blocked" : "ok";
}

/** Budget share as a whole percent, clamped to 0..999 for display only. */
export function usedPercent(spendUsd: number, limits: Limits): number {
  return Math.min(999, percent(spendUsd, limits.budgetUsd));
}

export function usageTone(policy: EffectivePolicy): Tone {
  return policy.status;
}

export function requestStateTone(state: string): Tone {
  switch (state) {
    case "approved":
      return "ok";
    case "partly_approved":
      return "soft";
    case "denied":
      return "blocked";
    case "pending":
      return "accent";
    default:
      return "neutral";
  }
}
