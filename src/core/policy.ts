import {
  DEFAULT_GRACE_RATIO,
  DEFAULT_OFF_HOURS_CAP_USD,
  DEFAULT_SOFT_RATIO,
  DEFAULT_UNUSUAL_SPEND_MIN_USD,
  type DesiredKeyState,
  type EffectivePolicy,
  type GatewayBudgetDuration,
  type Grant,
  type Limits,
  type Member,
  type ModelEntry,
  type Status,
  type TeamId,
  type TeamPolicy,
  type Thresholds,
  type Usd,
} from "../contracts.ts";
import { toIso } from "./time.ts";

/**
 * Policy math, pure. No clock read, no store, no network.
 *
 * Policy rules: team defaults narrowed by the
 * member's own settings, plus active grants; then the status from spend.
 */

export interface EffectivePolicyInput {
  member: Member;
  limits: Limits;
  /** The member's own allowed-model list; empty means "no narrowing". */
  modelSelection: readonly string[];
  catalogue: readonly ModelEntry[];
  teamPolicy: TeamPolicy;
  /** Every grant for this member; the active ones are selected here. */
  grants: readonly Grant[];
  spendThisPeriodUsd: Usd;
  now: Date;
  /** True when the gateway currently holds a block on this member's key. */
  keyBlocked?: boolean;
}

export function defaultTeamPolicy(teamId: TeamId, now: Date): TeamPolicy {
  return {
    teamId,
    offHours: {
      enabled: true,
      timeZone: "Europe/Berlin",
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 7 * 60,
      endMinute: 19 * 60,
      holidays: [],
      capUsd: DEFAULT_OFF_HOURS_CAP_USD,
    },
    thresholds: { softRatio: DEFAULT_SOFT_RATIO, graceRatio: DEFAULT_GRACE_RATIO },
    unusualSpendMinUsd: DEFAULT_UNUSUAL_SPEND_MIN_USD,
    notifications: [],
    updatedAt: toIso(now),
  };
}

export function isGrantActive(grant: Grant, now: Date): boolean {
  if (grant.revokedAt !== null) return false;
  const startsAt = new Date(grant.startsAt).getTime();
  if (Number.isNaN(startsAt) || startsAt > now.getTime()) return false;
  if (grant.expiresAt === null) return true;
  const expiresAt = new Date(grant.expiresAt).getTime();
  return !Number.isNaN(expiresAt) && expiresAt > now.getTime();
}

export function activeGrants(grants: readonly Grant[], now: Date): Grant[] {
  return grants.filter((grant) => isGrantActive(grant, now));
}

/** Models a member may use without a grant: enabled, then narrowed by choice. */
export function baseAllowedModels(
  catalogue: readonly ModelEntry[],
  modelSelection: readonly string[],
): string[] {
  const enabled = catalogue.filter((entry) => entry.state === "enabled").map((entry) => entry.id);
  if (modelSelection.length === 0) return enabled;
  const selected = new Set(modelSelection);
  return enabled.filter((id) => selected.has(id));
}

/**
 * A grant may open an `approval-required` model but never a `blocked` one, and
 * only for a model the catalogue actually serves.
 */
export function grantedModels(
  catalogue: readonly ModelEntry[],
  grants: readonly Grant[],
): string[] {
  const byId = new Map(catalogue.map((entry) => [entry.id, entry]));
  const models: string[] = [];
  for (const grant of grants) {
    if (grant.scope !== "model" || grant.modelId === null) continue;
    const entry = byId.get(grant.modelId);
    if (entry === undefined || entry.state === "blocked") continue;
    models.push(grant.modelId);
  }
  return models;
}

export function computeStatus(input: {
  effectiveBudgetUsd: Usd;
  spendThisPeriodUsd: Usd;
  thresholds: Thresholds;
  memberBlocked: boolean;
  keyBlocked?: boolean;
}): Status {
  const { effectiveBudgetUsd, spendThisPeriodUsd, thresholds } = input;
  if (input.memberBlocked || input.keyBlocked === true) return "blocked";
  const epsilon = 1e-9;
  // The gateway key ceiling is floored to whole cents; the status must use the
  // same number or the console can say "grace" while the gateway refuses.
  const hard = hardLimitUsd(effectiveBudgetUsd, thresholds);
  if (spendThisPeriodUsd + epsilon >= hard) return "blocked";
  if (spendThisPeriodUsd + epsilon >= effectiveBudgetUsd) return "grace";
  if (spendThisPeriodUsd + epsilon >= effectiveBudgetUsd * thresholds.softRatio) return "soft";
  return "ok";
}

/** The spend at which the member is hard-blocked: budget plus the grace share. */
export function hardLimitUsd(budgetUsd: Usd, thresholds: Thresholds): Usd {
  return floorCents(budgetUsd * (1 + thresholds.graceRatio));
}

export function computeEffectivePolicy(input: EffectivePolicyInput): EffectivePolicy {
  const active = activeGrants(input.grants, input.now);

  const budgetGrants = active
    .filter((grant) => grant.scope === "budget")
    .reduce((sum, grant) => sum + (grant.amountUsd ?? 0), 0);
  const effectiveBudgetUsd = roundCents(input.limits.budgetUsd + budgetGrants);

  const tokenGrants = active.filter((grant) => grant.scope === "token_cap");
  const hasTokenGrant = tokenGrants.some((grant) => grant.tokenCap !== null);
  const effectiveTokenCap =
    input.limits.tokenCap === null && !hasTokenGrant
      ? null
      : (input.limits.tokenCap ?? 0) +
        tokenGrants.reduce((sum, grant) => sum + (grant.tokenCap ?? 0), 0);

  const models = new Set([
    ...baseAllowedModels(input.catalogue, input.modelSelection),
    ...grantedModels(input.catalogue, active),
  ]);

  const status = computeStatus({
    effectiveBudgetUsd,
    spendThisPeriodUsd: input.spendThisPeriodUsd,
    thresholds: input.teamPolicy.thresholds,
    memberBlocked: input.member.blocked,
    ...(input.keyBlocked === undefined ? {} : { keyBlocked: input.keyBlocked }),
  });

  return {
    memberId: input.member.id,
    allowedModels: [...models].sort(),
    limits: input.limits,
    grants: active,
    blocked: status === "blocked",
    blockedReason: input.member.blockedReason,
    effectiveBudgetUsd,
    effectiveTokenCap,
    status,
    computedAt: toIso(input.now),
  };
}

const DURATION_BY_PERIOD: Record<Limits["period"], GatewayBudgetDuration> = {
  daily: "1d",
  weekly: "7d",
  monthly: "30d",
};

export function budgetDurationFor(period: Limits["period"]): GatewayBudgetDuration {
  return DURATION_BY_PERIOD[period];
}

export function floorCents(usd: Usd): Usd {
  return Math.floor((usd + 1e-9) * 100) / 100;
}

export function roundCents(usd: Usd): Usd {
  return Math.round((usd + Number.EPSILON) * 100) / 100;
}

/**
 * Map an effective policy to the state the gateway should hold for the key.
 *
 * The gateway's hard stop is at 100% plus the grace share, so
 * the key budget carries that headroom: the member can spend inside the grace
 * band and is refused at the hard limit. The team's own grace ratio is passed
 * in; the contract default applies when a caller omits it.
 */
export function computeDesiredKeyState(
  policy: EffectivePolicy,
  graceRatio: number = DEFAULT_GRACE_RATIO,
): DesiredKeyState {
  return {
    keyAlias: keyAliasForMemberId(policy.memberId),
    models: [...new Set(policy.allowedModels)].sort(),
    maxBudgetUsd: floorCents(policy.effectiveBudgetUsd * (1 + graceRatio)),
    budgetDuration: budgetDurationFor(policy.limits.period),
    tpmLimit: policy.limits.tpm,
    rpmLimit: policy.limits.rpm,
    blocked: policy.blocked,
  };
}

/** `taa-<memberId>` is the canonical gateway key alias. */
export function keyAliasForMemberId(memberId: string): string {
  return `taa-${memberId}`;
}
