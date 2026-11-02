/**
 * Manager routes (`/api/team`).
 *
 * A manager is pinned to their own team; an admin may pass `?teamId=` on list
 * routes. Object routes are checked against the object's own team, so a
 * manager token from another team is refused with 403, not 404.
 */

import type {
  AuditFilter,
  DecisionOutcome,
  Limits,
  Request,
  RequestFilter,
  RequestState,
  Rule,
  RuleCondition,
  TeamPolicy,
} from "../../contracts.ts";
import type { LimitsPatch } from "../control.ts";
import type { ApiDependencies } from "../deps.ts";
import { badRequest, notFound } from "../errors.ts";
import { actorOf, assertObjectTeam, requirePrincipal, scopedTeamId } from "../guard.ts";
import { publicMember, publicMemberDetail, publicTeamOverview } from "../redact.ts";
import type { RequestContext, Router } from "../router.ts";
import {
  enumValue,
  isoDateTime,
  limitFromQuery,
  objectBody,
  optionalBoolean,
  optionalEnum,
  optionalIsoDateTime,
  optionalNullableNumber,
  optionalNumber,
  optionalString,
  requiredBoolean,
  requiredNumber,
  requiredString,
  stringArray,
} from "../validate.ts";

const REQUEST_STATES = [
  "pending",
  "approved",
  "partly_approved",
  "denied",
  "expired",
  "cancelled",
] as const satisfies readonly RequestState[];

const DECISION_OUTCOMES = [
  "approved",
  "partly_approved",
  "denied",
] as const satisfies readonly DecisionOutcome[];

const PERIODS = ["daily", "weekly", "monthly"] as const satisfies readonly Limits["period"][];

export function registerManagerRoutes(router: Router, deps: ApiDependencies): void {
  router.add("GET", "/api/team/overview", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const overview = await deps.control.getTeamOverview(scopedTeamId(context, principal));
    return { status: 200, body: publicTeamOverview(overview) };
  });

  router.add("GET", "/api/team/requests", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = scopedTeamId(context, principal);
    const memberId = context.query.get("memberId");
    const filter: RequestFilter = {
      teamId,
      limit: limitFromQuery(context.query.get("limit"), { fallback: 100, max: 500 }),
    };
    if (memberId !== null && memberId.length > 0) {
      const member = await loadMember(deps, principal, memberId);
      filter.memberId = member.id;
    }
    const state = context.query.get("state");
    if (state !== null && state.length > 0) {
      filter.state = enumValue("state", state, REQUEST_STATES);
    }
    const requests = await deps.control.listRequests(filter);
    return { status: 200, body: requests };
  });

  router.add("POST", "/api/team/requests/:id/decide", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const requestId = context.params.id;
    if (requestId === undefined) throw notFound("Request not found.");
    const request = await loadRequest(deps, principal, requestId);
    const body = objectBody(context.body);
    const result = await deps.control.decideRequest(actorOf(principal), request.id, {
      outcome: enumValue("outcome", body.outcome, DECISION_OUTCOMES),
      note: optionalString(body, "note", { maxLength: 2000 }) ?? null,
      amountUsd: optionalNumber(body, "amountUsd", { min: 0.01, max: 10_000 }) ?? null,
      modelId: optionalString(body, "modelId", { maxLength: 200 }) ?? null,
      until: optionalIsoDateTime("until", body.until) ?? null,
      permanent: optionalBoolean(body, "permanent") ?? false,
    });
    return { status: 200, body: result };
  });

  router.add("POST", "/api/team/grants/:id/revoke", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const grantId = context.params.id;
    if (grantId === undefined) throw notFound("Grant not found.");
    const body = objectBody(context.body);
    const reason = requiredString(body, "reason", { minLength: 1, maxLength: 500 });
    const grant = await deps.control.revokeGrant(actorOf(principal), grantId, reason);
    return { status: 200, body: grant };
  });

  router.add("GET", "/api/team/members", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const members = await deps.control.listMembers(scopedTeamId(context, principal));
    return { status: 200, body: members.map(publicMember) };
  });

  router.add("GET", "/api/team/usage", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = scopedTeamId(context, principal);
    const to = queryDate(context.query.get("to"), "to") ?? deps.clock.now().toISOString();
    const from =
      queryDate(context.query.get("from"), "from") ??
      new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(from) > Date.parse(to)) {
      throw badRequest("from must be before to.", { field: "from" });
    }
    const usage = await deps.control.listUsage({ teamId, from, to });
    return { status: 200, body: usage };
  });

  router.add("GET", "/api/team/members/:id", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const memberId = context.params.id;
    if (memberId === undefined) throw notFound("Member not found.");
    const member = await loadMember(deps, principal, memberId);
    const detail = await deps.control.getMemberDetail(member.teamId, member.id);
    if (detail === null) throw notFound("Member not found.");
    return { status: 200, body: publicMemberDetail(detail) };
  });

  router.add("PATCH", "/api/team/members/:id/limits", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const memberId = context.params.id;
    if (memberId === undefined) throw notFound("Member not found.");
    const member = await loadMember(deps, principal, memberId);
    const body = objectBody(context.body);

    const patch: LimitsPatch = {};
    const budgetUsd = optionalNumber(body, "budgetUsd", { min: 0, max: 1_000_000 });
    if (budgetUsd !== undefined) patch.budgetUsd = budgetUsd;
    const period = optionalEnum("period", body.period, PERIODS);
    if (period !== undefined) patch.period = period;
    const tokenCap = optionalNullableNumber(body, "tokenCap", {
      min: 1,
      max: 1_000_000_000,
      integer: true,
    });
    if (tokenCap !== undefined) patch.tokenCap = tokenCap;
    const rpm = optionalNullableNumber(body, "rpm", { min: 1, max: 1_000_000, integer: true });
    if (rpm !== undefined) patch.rpm = rpm;
    const tpm = optionalNullableNumber(body, "tpm", { min: 1, max: 100_000_000, integer: true });
    if (tpm !== undefined) patch.tpm = tpm;
    if (Object.keys(patch).length === 0) throw badRequest("No limits supplied.");

    const result = await deps.control.setLimits(actorOf(principal), member.id, patch);
    return {
      status: 200,
      body: { member: publicMember(result.member), policy: result.policy },
    };
  });

  router.add("PATCH", "/api/team/members/:id/models", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const memberId = context.params.id;
    if (memberId === undefined) throw notFound("Member not found.");
    const member = await loadMember(deps, principal, memberId);
    const body = objectBody(context.body);
    const modelIds = stringArray(body, "modelIds", { maxItems: 500, maxLength: 200 });
    const result = await deps.control.setModels(actorOf(principal), member.id, modelIds);
    return {
      status: 200,
      body: { member: publicMember(result.member), policy: result.policy },
    };
  });

  router.add("POST", "/api/team/members/:id/key/block", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const member = await loadMemberParam(context, deps, principal);
    const body = objectBody(context.body);
    const reason = requiredString(body, "reason", { minLength: 1, maxLength: 500 });
    const result = await deps.control.blockKey(actorOf(principal), member.id, reason);
    return {
      status: 200,
      body: { member: publicMember(result.member), policy: result.policy },
    };
  });

  router.add("POST", "/api/team/members/:id/key/unblock", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const member = await loadMemberParam(context, deps, principal);
    const result = await deps.control.unblockKey(actorOf(principal), member.id);
    return {
      status: 200,
      body: { member: publicMember(result.member), policy: result.policy },
    };
  });

  router.add("POST", "/api/team/members/:id/key/rotate", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const member = await loadMemberParam(context, deps, principal);
    const rotated = await deps.control.rotateKey(actorOf(principal), member.id);
    return {
      status: 200,
      body: { member: publicMember(rotated.member), secret: rotated.secret },
    };
  });

  router.add("GET", "/api/team/audit", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const filter: AuditFilter = {
      teamId: scopedTeamId(context, principal),
      limit: limitFromQuery(context.query.get("limit"), { fallback: 100, max: 1000 }),
    };
    const actorId = context.query.get("actorId");
    if (actorId !== null && actorId.length > 0) filter.actorId = actorId;
    const objectType = context.query.get("objectType");
    if (objectType !== null && objectType.length > 0) filter.objectType = objectType;
    const objectId = context.query.get("objectId");
    if (objectId !== null && objectId.length > 0) filter.objectId = objectId;
    const from = context.query.get("from");
    if (from !== null && from.length > 0) filter.from = isoDateTime("from", from);
    const to = context.query.get("to");
    if (to !== null && to.length > 0) filter.to = isoDateTime("to", to);
    const events = await deps.control.listAudit(filter.teamId ?? principal.member.teamId, filter);
    return { status: 200, body: events };
  });

  router.add("GET", "/api/team/rules", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const rules = await deps.control.listRules(scopedTeamId(context, principal));
    return { status: 200, body: rules };
  });

  router.add("PUT", "/api/team/rules/:id", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const ruleId = context.params.id;
    if (ruleId === undefined) throw notFound("Rule not found.");
    const existing = await deps.control.getRule(ruleId);
    if (existing === null) throw notFound("Rule not found.");
    assertObjectTeam(principal, existing.teamId);

    const body = objectBody(context.body);
    const rule: Rule = {
      id: existing.id,
      teamId: existing.teamId,
      name: requiredString(body, "name", { minLength: 1, maxLength: 100 }),
      enabled: requiredBoolean(body, "enabled"),
      condition: parseRuleCondition(body.condition),
      createdAt: existing.createdAt,
    };
    const saved = await deps.control.upsertRule(actorOf(principal), rule);
    return { status: 200, body: saved };
  });

  router.add("GET", "/api/team/policy", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = scopedTeamId(context, principal);
    const policy = await deps.control.getTeamPolicy(teamId);
    if (policy === null) throw notFound("Team policy not found.");
    return { status: 200, body: policy };
  });

  router.add("PUT", "/api/team/policy", "manager", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = scopedTeamId(context, principal);
    const existing = await deps.control.getTeamPolicy(teamId);
    const body = objectBody(context.body);
    const policy = parseTeamPolicy(
      body,
      teamId,
      existing?.updatedAt ?? deps.clock.now().toISOString(),
    );
    const saved = await deps.control.setTeamPolicy(actorOf(principal), policy);
    return { status: 200, body: saved };
  });
}

async function loadMemberParam(
  context: RequestContext,
  deps: ApiDependencies,
  principal: ReturnType<typeof requirePrincipal>,
) {
  const memberId = context.params.id;
  if (memberId === undefined) throw notFound("Member not found.");
  return loadMember(deps, principal, memberId);
}

async function loadMember(
  deps: ApiDependencies,
  principal: ReturnType<typeof requirePrincipal>,
  memberId: string,
) {
  const member = await deps.control.getMember(memberId);
  if (member === null) throw notFound("Member not found.");
  assertObjectTeam(principal, member.teamId);
  return member;
}

async function loadRequest(
  deps: ApiDependencies,
  principal: ReturnType<typeof requirePrincipal>,
  requestId: string,
): Promise<Request> {
  const request = await deps.control.getRequest(requestId);
  if (request === null) throw notFound("Request not found.");
  assertObjectTeam(principal, request.teamId);
  return request;
}

function parseRuleCondition(value: unknown): RuleCondition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("condition must be an object.", { field: "condition" });
  }
  const condition = value as Record<string, unknown>;
  const kind = enumValue("condition.kind", condition.kind, [
    "budget_topup",
    "model_unlock",
  ] as const);
  if (kind === "budget_topup") {
    return {
      kind,
      maxUsd: requiredNumber(condition, "maxUsd", { min: 0, max: 10_000 }),
      oncePerDays: requiredNumber(condition, "oncePerDays", { min: 1, max: 365, integer: true }),
    };
  }
  return {
    kind,
    modelIds: stringArray(condition, "modelIds", { maxItems: 100, maxLength: 200 }),
    durationHours: requiredNumber(condition, "durationHours", { min: 1, max: 8760 }),
  };
}

const NOTIFICATION_CHANNELS = ["teams", "slack", "email", "webhook", "log"] as const;

function parseTeamPolicy(
  body: Record<string, unknown>,
  teamId: string,
  updatedAt: string,
): TeamPolicy {
  const offHoursRaw = objectBody(body.offHours);
  const timeZone = requiredString(offHoursRaw, "timeZone", { minLength: 1, maxLength: 100 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw badRequest("offHours.timeZone must be an IANA time zone.", {
      field: "offHours.timeZone",
    });
  }
  const workingDays = workingDaysOf(offHoursRaw.workingDays);
  const thresholdsRaw = objectBody(body.thresholds);
  const notificationsRaw = body.notifications;
  if (!Array.isArray(notificationsRaw) || notificationsRaw.length > 20) {
    throw badRequest("notifications must be an array of at most 20 entries.", {
      field: "notifications",
    });
  }

  return {
    teamId,
    offHours: {
      enabled: requiredBoolean(offHoursRaw, "enabled"),
      timeZone,
      workingDays,
      startMinute: requiredNumber(offHoursRaw, "startMinute", { min: 0, max: 1439, integer: true }),
      endMinute: requiredNumber(offHoursRaw, "endMinute", { min: 0, max: 1439, integer: true }),
      holidays: stringArray(offHoursRaw, "holidays", { maxItems: 366, maxLength: 10 }).map(
        (day, index) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            throw badRequest(`offHours.holidays[${index}] must be YYYY-MM-DD.`, {
              field: "offHours.holidays",
            });
          }
          return day;
        },
      ),
      capUsd: requiredNumber(offHoursRaw, "capUsd", { min: 0, max: 1_000_000 }),
    },
    thresholds: {
      softRatio: requiredNumber(thresholdsRaw, "softRatio", { min: 0, max: 1 }),
      graceRatio: requiredNumber(thresholdsRaw, "graceRatio", { min: 0, max: 1 }),
    },
    unusualSpendMinUsd: requiredNumber(body, "unusualSpendMinUsd", { min: 0, max: 1_000_000 }),
    notifications: notificationsRaw.map((entry, index) => {
      const item = objectBody(entry);
      const channel = enumValue(
        `notifications[${index}].channel`,
        item.channel,
        NOTIFICATION_CHANNELS,
      );
      const configRaw = item.config;
      if (typeof configRaw !== "object" || configRaw === null || Array.isArray(configRaw)) {
        throw badRequest(`notifications[${index}].config must be an object.`, {
          field: "notifications",
        });
      }
      const config: Record<string, string> = {};
      for (const [key, configValue] of Object.entries(configRaw)) {
        if (typeof configValue !== "string") {
          throw badRequest(`notifications[${index}].config.${key} must be a string.`, {
            field: "notifications",
          });
        }
        config[key] = configValue;
      }
      if (item.enabled !== true && item.enabled !== false) {
        throw badRequest(`notifications[${index}].enabled must be true or false.`, {
          field: "notifications",
        });
      }
      return { channel, config, enabled: item.enabled };
    }),
    updatedAt,
  };
}

function workingDaysOf(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    throw badRequest("offHours.workingDays must list 1 to 7 weekdays.", {
      field: "offHours.workingDays",
    });
  }
  const days: number[] = [];
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7) {
      throw badRequest("offHours.workingDays entries must be integers from 1 to 7.", {
        field: "offHours.workingDays",
      });
    }
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

function queryDate(value: string | null, field: string): string | undefined {
  if (value === null || value.length === 0) return undefined;
  return isoDateTime(field, value);
}
