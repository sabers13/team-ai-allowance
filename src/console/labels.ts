/**
 * The words the console uses for domain values. Kept in one place so a status,
 * a request kind or a grant reads the same on every page.
 */

import type {
  Grant,
  ModelEntry,
  ModelState,
  NotificationKind,
  Period,
  RequestKind,
  RequestState,
  Role,
  Rule,
} from "../contracts.ts";
import { money } from "./format.ts";

const REQUEST_KINDS: Readonly<Record<RequestKind, string>> = {
  more_budget: "More budget",
  model_unlock: "Model unlock",
  suggestion: "Suggestion",
};

const REQUEST_STATES: Readonly<Record<RequestState, string>> = {
  pending: "Pending",
  approved: "Approved",
  partly_approved: "Partly approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

const PERIODS: Readonly<Record<Period, string>> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const ROLES: Readonly<Record<Role, string>> = {
  admin: "Admin",
  manager: "Manager",
  member: "Member",
};

const MODEL_STATES: Readonly<Record<ModelState, string>> = {
  enabled: "Enabled",
  "approval-required": "Approval required",
  blocked: "Blocked",
};

const NOTIFICATIONS: Readonly<Record<NotificationKind, string>> = {
  request_created: "New request",
  request_decided: "Decision",
  soft_limit: "Soft limit",
  grace: "Grace",
  hard_limit: "Hard limit",
  off_hours_block: "Off-hours block",
  member_blocked: "Member blocked",
  grant_expired: "Grant expired",
  unusual_spend: "Unusual spend",
};

export function requestKindLabel(kind: RequestKind): string {
  return REQUEST_KINDS[kind];
}

export function requestStateLabel(state: RequestState): string {
  return REQUEST_STATES[state];
}

export function periodLabel(period: Period): string {
  return PERIODS[period];
}

export function roleLabel(role: Role): string {
  return ROLES[role];
}

export function modelStateLabel(state: ModelState): string {
  return MODEL_STATES[state];
}

export function notificationLabel(kind: NotificationKind): string {
  return NOTIFICATIONS[kind];
}

export function periodDuration(period: Period): string {
  switch (period) {
    case "daily":
      return "a day";
    case "weekly":
      return "a week";
    default:
      return "a month";
  }
}

export function modelName(models: ModelEntry[], modelId: string): string {
  return models.find((model) => model.id === modelId)?.displayName ?? modelId;
}

export function grantSummary(grant: Grant, models: ModelEntry[]): string {
  switch (grant.scope) {
    case "budget":
      return `+${money(grant.amountUsd ?? 0)} budget`;
    case "token_cap":
      return `+${(grant.tokenCap ?? 0).toLocaleString("en-GB")} tokens`;
    default:
      return `Unlock ${modelName(models, grant.modelId ?? "")}`;
  }
}

export function requestSubject(request: {
  kind: RequestKind;
  amountUsd: number | null;
  modelId: string | null;
  message: string;
}): string {
  switch (request.kind) {
    case "more_budget":
      return request.amountUsd === null ? "More budget" : `+USD ${money(request.amountUsd)}`;
    case "model_unlock":
      return request.modelId === null ? "Model unlock" : `Unlock ${request.modelId}`;
    default:
      return "Suggestion";
  }
}

export function ruleSummary(rule: Rule, models: ModelEntry[]): string {
  if (rule.condition.kind === "budget_topup") {
    return `Auto-approve up to USD ${money(rule.condition.maxUsd)}, once every ${rule.condition.oncePerDays} ${rule.condition.oncePerDays === 1 ? "day" : "days"}.`;
  }
  const ids = rule.condition.modelIds.map((id) => modelName(models, id)).join(", ");
  return `Auto-approve ${ids} for ${rule.condition.durationHours} ${rule.condition.durationHours === 1 ? "hour" : "hours"}.`;
}
