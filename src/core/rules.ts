import type { Grant, IsoDateTime, Request, Rule, Usd } from "../contracts.ts";
import { isGrantActive } from "./policy.ts";
import { withinDays } from "./requests.ts";
import { addHours, toIso } from "./time.ts";

/**
 * Auto-approve rules, pure evaluation.
 *
 * A rule only ever approves; it never denies and never overrides a manager. It
 * matches at most one request, once, and the caller logs the decision with
 * `source: "rule"` and the rule id as the decider.
 */

export interface RuleEvaluationInput {
  request: Request;
  rules: readonly Rule[];
  /** Every grant for the member, including expired ones. */
  grants: readonly Grant[];
  now: Date;
}

export interface RuleMatch {
  rule: Rule;
  amountUsd: Usd | null;
  modelId: string | null;
  /** For a model rule, the end of its fixed duration; otherwise null. */
  until: IsoDateTime | null;
}

function priorRuleGrants(input: RuleEvaluationInput, rule: Rule): Grant[] {
  return input.grants.filter(
    (grant) => grant.memberId === input.request.memberId && grant.issuedById === rule.id,
  );
}

function budgetRuleMatches(input: RuleEvaluationInput, rule: Rule): RuleMatch | null {
  const condition = rule.condition;
  if (condition.kind !== "budget_topup") return null;
  if (input.request.kind !== "more_budget") return null;
  const requested = input.request.amountUsd;
  if (requested === null) return null;
  if (requested > condition.maxUsd) return null;

  const prior = priorRuleGrants(input, rule);
  const used =
    condition.oncePerDays > 0
      ? prior.filter((grant) => withinDays(grant.createdAt, input.now, condition.oncePerDays))
      : prior;
  if (used.length > 0) return null;

  return { rule, amountUsd: requested, modelId: null, until: null };
}

function modelRuleMatches(input: RuleEvaluationInput, rule: Rule): RuleMatch | null {
  const condition = rule.condition;
  if (condition.kind !== "model_unlock") return null;
  if (input.request.kind !== "model_unlock") return null;
  const modelId = input.request.modelId;
  if (modelId === null) return null;
  if (!condition.modelIds.includes(modelId)) return null;

  const alreadyOpen = priorRuleGrants(input, rule).some(
    (grant) =>
      grant.scope === "model" && grant.modelId === modelId && isGrantActive(grant, input.now),
  );
  if (alreadyOpen) return null;

  return {
    rule,
    amountUsd: null,
    modelId,
    until: toIso(addHours(input.now, condition.durationHours)),
  };
}

/** First enabled rule that matches, in the order the store returns them. */
export function findMatchingRule(input: RuleEvaluationInput): RuleMatch | null {
  if (input.request.state !== "pending") return null;
  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    if (rule.teamId !== input.request.teamId) continue;
    const match =
      rule.condition.kind === "budget_topup"
        ? budgetRuleMatches(input, rule)
        : modelRuleMatches(input, rule);
    if (match !== null) return match;
  }
  return null;
}

export function ruleNote(match: RuleMatch): string {
  return `Auto-approved by rule "${match.rule.name}" (${match.rule.id}).`;
}
