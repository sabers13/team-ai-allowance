import type {
  AuditActor,
  Clock,
  Decision,
  EffectivePolicy,
  GatewayClient,
  Grant,
  GrantId,
  Limits,
  Member,
  ModelEntry,
  Notification,
  Notifier,
  Request,
  Rule,
  RuleCondition,
  TeamPolicy,
  Usd,
} from "../contracts.ts";
import { AUDIT_ACTIONS, AuditTrail, makeActor, SYSTEM_ACTOR } from "./audit.ts";
import { DomainError, forbidden, invalidState, notFound } from "./errors.ts";
import type { IdSource } from "./ids.ts";
import { randomIds } from "./ids.ts";
import { computeEffectivePolicy, defaultTeamPolicy, roundCents } from "./policy.ts";
import type { CoreStore } from "./ports.ts";
import {
  defaultScheduler,
  type IntervalScheduler,
  type LoopOptions,
  type ReconcileResult,
  Reconciler,
  ReconciliationLoop,
} from "./reconciler.ts";
import {
  buildRequest,
  cancelRequest,
  type DecideOptions,
  type DecisionInput,
  decideRequest,
  expireRequest,
  isRequestDue,
  type RequestContextInput,
} from "./requests.ts";
import { findMatchingRule, ruleNote } from "./rules.ts";
import { addDays, periodStart, toIso } from "./time.ts";

/**
 * Request and grant use cases.
 *
 * Every method appends audit events and leaves the gateway reconciled before it
 * returns. Store writes happen in one transaction; gateway calls happen after
 * the commit, so a slow gateway never holds a SQLite transaction open.
 */

export interface StaffActor {
  type: "manager" | "admin";
  id: string;
  role: "manager" | "admin";
  /** The team the staff member belongs to. A manager is pinned to it. */
  teamId: string;
  displayName?: string | null;
}

export interface ControlServiceDeps {
  store: CoreStore;
  gateway: GatewayClient;
  clock: Clock;
  ids?: IdSource;
  /** A notifier that already knows the channels to use. */
  notifier?: Notifier;
  /** Build a notifier from the team policy, when a channel depends on it. */
  notifyFactory?: (policy: TeamPolicy) => Notifier;
  /** Absolute console URL used in notification links. */
  publicUrl?: string | null;
}

export interface CreateRequestInput {
  memberId: string;
  kind: Request["kind"];
  message: string;
  amountUsd?: Usd;
  modelId?: string;
}

export interface CreateRequestResult {
  request: Request;
  decision: Decision | null;
  grant: Grant | null;
}

export interface DecideRequestResult {
  request: Request;
  decision: Decision;
  grant: Grant | null;
}

export interface ExpiryResult {
  expiredRequests: Request[];
  expiredGrants: Grant[];
  reconcile: ReconcileResult | null;
}

interface PolicyBundle {
  member: Member;
  limits: Limits;
  teamPolicy: TeamPolicy;
  catalogue: ModelEntry[];
  grants: Grant[];
  modelSelection: string[];
  policy: EffectivePolicy;
}

function staffActor(actor: StaffActor): AuditActor {
  return makeActor(actor.type, actor.id, actor.displayName ?? null);
}

function memberActor(member: Member): AuditActor {
  return makeActor("member", member.id, member.displayName);
}

function roundUsd(value: number): Usd {
  return roundCents(value);
}

export const EXPIRY_INTERVAL_MS = 60 * 1000;

export class ControlService {
  private readonly store: CoreStore;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly trail: AuditTrail;
  private readonly reconciler: Reconciler;
  private readonly notifier: Notifier | null;
  private readonly notifyFactory: ((policy: TeamPolicy) => Notifier) | null;
  private readonly publicUrl: string | null;

  constructor(deps: ControlServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ids = deps.ids ?? randomIds();
    this.trail = new AuditTrail(deps.store, this.ids, deps.clock);
    this.notifier = deps.notifier ?? null;
    this.notifyFactory = deps.notifyFactory ?? null;
    this.publicUrl = deps.publicUrl?.replace(/\/+$/u, "") ?? null;
    this.reconciler = new Reconciler({
      store: deps.store,
      gateway: deps.gateway,
      clock: deps.clock,
      ids: this.ids,
    });
  }

  private async loadPolicyBundle(memberId: string, now: Date): Promise<PolicyBundle> {
    const member = await this.store.getMember(memberId);
    if (member === null) notFound("Unknown member.");
    const limits = await this.store.getLimits(memberId);
    if (limits === null) invalidState("The member has no limits yet.");
    const teamPolicy =
      (await this.store.getTeamPolicy(member.teamId)) ?? defaultTeamPolicy(member.teamId, now);
    const catalogue = await this.store.listModels();
    const grants = await this.store.listGrants(memberId);
    const modelSelection = await this.store.getMemberModels(memberId);
    const from = toIso(periodStart(limits.period, now));
    const usage = await this.store.listUsage({ memberId, from, to: toIso(now) });
    const spendThisPeriodUsd = usage.reduce((sum, row) => sum + row.costUsd, 0);
    const policy = computeEffectivePolicy({
      member,
      limits,
      modelSelection,
      catalogue,
      teamPolicy,
      grants,
      spendThisPeriodUsd,
      now,
    });
    return { member, limits, teamPolicy, catalogue, grants, modelSelection, policy };
  }

  async effectivePolicy(memberId: string): Promise<EffectivePolicy> {
    const now = this.clock.now();
    return (await this.loadPolicyBundle(memberId, now)).policy;
  }

  private requireStaff(actor: StaffActor, action: string): void {
    if (actor.type !== "manager" && actor.type !== "admin") {
      forbidden(`Only a manager or an admin can ${action}.`);
    }
  }

  /**
   * A manager acts only inside their own team. An admin may cross teams.
   * Every use case that names a member, request, grant, rule or policy goes
   * through here, so the console and the API cannot diverge.
   */
  private requireSameTeam(actor: StaffActor, teamId: string, action: string): void {
    if (actor.type === "admin") return;
    if (actor.teamId !== teamId) {
      forbidden(`A manager cannot ${action} in another team.`);
    }
  }

  private validateLimits(limits: Limits): void {
    if (!Number.isFinite(limits.budgetUsd) || limits.budgetUsd < 0) {
      throw new DomainError("invalid_input", "The budget must be zero or more.");
    }
    if (limits.tokenCap !== null && (!Number.isInteger(limits.tokenCap) || limits.tokenCap < 0)) {
      throw new DomainError("invalid_input", "The token cap must be a whole number or null.");
    }
    if (limits.rpm !== null && (!Number.isInteger(limits.rpm) || limits.rpm < 1)) {
      throw new DomainError("invalid_input", "rpm must be a whole number or null.");
    }
    if (limits.tpm !== null && (!Number.isInteger(limits.tpm) || limits.tpm < 1)) {
      throw new DomainError("invalid_input", "tpm must be a whole number or null.");
    }
  }

  /**
   * The console and the API build rules independently; the service is the one
   * place both must pass, so a rule that can never match is refused here.
   */
  private validateRuleCondition(condition: RuleCondition): void {
    if (condition.kind === "budget_topup") {
      if (!Number.isFinite(condition.maxUsd) || condition.maxUsd <= 0) {
        throw new DomainError("invalid_input", "A top-up rule needs a positive USD limit.");
      }
      if (!Number.isInteger(condition.oncePerDays) || condition.oncePerDays < 1) {
        throw new DomainError("invalid_input", "A top-up rule needs a window of at least one day.");
      }
      return;
    }
    if (!Number.isInteger(condition.durationHours) || condition.durationHours < 1) {
      throw new DomainError("invalid_input", "A model-unlock rule needs at least one hour.");
    }
    if (condition.modelIds.length === 0) {
      throw new DomainError("invalid_input", "A model-unlock rule needs at least one model.");
    }
  }

  async setMemberLimits(
    memberId: string,
    limits: Limits,
    actor: StaffActor,
    reason: string | null = null,
  ): Promise<Limits> {
    this.requireStaff(actor, "change a member's limits");
    this.validateLimits(limits);
    const member = await this.store.getMember(memberId);
    if (member === null) notFound("Unknown member.");
    this.requireSameTeam(actor, member.teamId, "change a member's limits");
    const now = this.clock.now();
    const before = await this.store.getLimits(memberId);
    await this.store.transaction(async () => {
      await this.store.setLimits(memberId, limits);
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.limitsUpdated,
        objectType: "limits",
        objectId: memberId,
        before,
        after: limits,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return limits;
  }

  async setMemberModels(
    memberId: string,
    modelIds: string[],
    actor: StaffActor,
    reason: string | null = null,
  ): Promise<string[]> {
    this.requireStaff(actor, "change a member's models");
    const member = await this.store.getMember(memberId);
    if (member === null) notFound("Unknown member.");
    this.requireSameTeam(actor, member.teamId, "change a member's models");
    const catalogue = await this.store.listModels();
    const known = new Set(catalogue.map((model) => model.id));
    for (const modelId of modelIds) {
      if (!known.has(modelId)) {
        throw new DomainError("invalid_input", `Unknown model "${modelId}".`);
      }
    }
    const now = this.clock.now();
    const before = await this.store.getMemberModels(memberId);
    let after: string[] = [];
    await this.store.transaction(async () => {
      after = await this.store.setMemberModels(memberId, modelIds, toIso(now));
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.modelsUpdated,
        objectType: "member_models",
        objectId: memberId,
        before,
        after,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return after;
  }

  async upsertRule(rule: Rule, actor: StaffActor, reason: string | null = null): Promise<Rule> {
    this.requireStaff(actor, "change an auto-approve rule");
    const team = await this.store.getTeam(rule.teamId);
    if (team === null) notFound("Unknown team.");
    this.requireSameTeam(actor, rule.teamId, "change an auto-approve rule");
    this.validateRuleCondition(rule.condition);
    const now = this.clock.now();
    const before = await this.store.getRule(rule.id);
    await this.store.transaction(async () => {
      await this.store.upsertRule(rule);
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.ruleUpserted,
        objectType: "rule",
        objectId: rule.id,
        before,
        after: rule,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return rule;
  }

  async deleteRule(ruleId: string, actor: StaffActor, reason: string | null = null): Promise<Rule> {
    this.requireStaff(actor, "delete an auto-approve rule");
    const before = await this.store.getRule(ruleId);
    if (before === null) notFound("Unknown rule.");
    this.requireSameTeam(actor, before.teamId, "delete an auto-approve rule");
    const now = this.clock.now();
    await this.store.transaction(async () => {
      await this.store.deleteRule(ruleId);
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.ruleDeleted,
        objectType: "rule",
        objectId: ruleId,
        before,
        after: null,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return before;
  }

  async setTeamPolicy(
    policy: TeamPolicy,
    actor: StaffActor,
    reason: string | null = null,
  ): Promise<TeamPolicy> {
    this.requireStaff(actor, "change the team policy");
    const team = await this.store.getTeam(policy.teamId);
    if (team === null) notFound("Unknown team.");
    this.requireSameTeam(actor, policy.teamId, "change the team policy");
    const now = this.clock.now();
    const before = await this.store.getTeamPolicy(policy.teamId);
    await this.store.transaction(async () => {
      await this.store.setTeamPolicy(policy);
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.teamPolicyUpdated,
        objectType: "team_policy",
        objectId: policy.teamId,
        before,
        after: policy,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return policy;
  }

  async setMemberBlocked(
    memberId: string,
    blocked: boolean,
    actor: StaffActor,
    reason: string | null = null,
  ): Promise<Member> {
    this.requireStaff(actor, blocked ? "block a member" : "unblock a member");
    const member = await this.store.getMember(memberId);
    if (member === null) notFound("Unknown member.");
    this.requireSameTeam(actor, member.teamId, blocked ? "block a member" : "unblock a member");
    if (member.blocked === blocked && member.blockedReason === (blocked ? reason : null)) {
      return member;
    }
    const now = this.clock.now();
    let updated = member;
    await this.store.transaction(async () => {
      updated = await this.store.updateMember(memberId, {
        blocked,
        blockedReason: blocked ? reason : null,
      });
      await this.trail.record({
        actor: staffActor(actor),
        action: blocked ? AUDIT_ACTIONS.memberBlocked : AUDIT_ACTIONS.memberUnblocked,
        objectType: "member",
        objectId: memberId,
        before: member,
        after: updated,
        reason,
        at: now,
      });
    });
    await this.reconcile();
    return updated;
  }

  private async contextFor(bundle: PolicyBundle, now: Date): Promise<RequestContextInput> {
    const from = periodStart(bundle.limits.period, now);
    const periodUsage = await this.store.listUsage({
      memberId: bundle.member.id,
      from: toIso(from),
      to: toIso(now),
    });
    const weekUsage = await this.store.listUsage({
      memberId: bundle.member.id,
      from: toIso(addDays(now, -7)),
      to: toIso(now),
    });

    const byModel = new Map<string, number>();
    for (const row of periodUsage) {
      byModel.set(row.modelId, (byModel.get(row.modelId) ?? 0) + row.costUsd);
    }
    const topModels = [...byModel.entries()]
      .map(([modelId, spendUsd]) => ({ modelId, spendUsd: roundUsd(spendUsd) }))
      .sort((a, b) => b.spendUsd - a.spendUsd || a.modelId.localeCompare(b.modelId))
      .slice(0, 3);

    return {
      spendThisPeriodUsd: roundUsd(periodUsage.reduce((sum, row) => sum + row.costUsd, 0)),
      limitUsd: bundle.policy.effectiveBudgetUsd,
      topModels,
      last7DaysUsd: roundUsd(weekUsage.reduce((sum, row) => sum + row.costUsd, 0)),
    };
  }

  private decisionOptions(bundle: PolicyBundle, now: Date): DecideOptions {
    return {
      now,
      grantId: this.ids.next("grn"),
      decisionId: this.ids.next("dec"),
      budgetPeriod: bundle.limits.period,
    };
  }

  private notifierFor(policy: TeamPolicy | null): Notifier | null {
    if (this.notifier !== null) return this.notifier;
    if (this.notifyFactory !== null && policy !== null) return this.notifyFactory(policy);
    return null;
  }

  private link(path: string): string | null {
    return this.publicUrl === null ? null : `${this.publicUrl}${path}`;
  }

  private notice(input: {
    kind: Notification["kind"];
    audience: Notification["audience"];
    teamId: string;
    memberId: string | null;
    title: string;
    body: string;
    link: string | null;
    dedupeKey: string;
    at: Date;
  }): Notification {
    return {
      id: this.ids.next("ntf"),
      at: toIso(input.at),
      kind: input.kind,
      audience: input.audience,
      teamId: input.teamId,
      memberId: input.memberId,
      title: input.title,
      body: input.body,
      link: input.link,
      dedupeKey: input.dedupeKey,
    };
  }

  /**
   * Send one notice and record the delivery. A channel failure is recorded by
   * the notifier and never fails the request; a missing notifier (tests, a
   * CLI-only deployment) simply records nothing.
   */
  private async deliver(notice: Notification, policy: TeamPolicy | null, now: Date): Promise<void> {
    const notifier = this.notifierFor(policy);
    if (notifier === null) return;
    let channels: string[] = [];
    try {
      const deliveries = await notifier.send(notice);
      channels = deliveries.filter((delivery) => delivery.ok).map((delivery) => delivery.channel);
    } catch {
      return;
    }
    try {
      await this.trail.record({
        actor: SYSTEM_ACTOR,
        action: AUDIT_ACTIONS.notificationSent,
        objectType: "notification",
        objectId: notice.dedupeKey,
        before: null,
        after: {
          kind: notice.kind,
          audience: notice.audience,
          title: notice.title,
          channels,
          teamId: notice.teamId,
          memberId: notice.memberId,
        },
        reason: notice.kind,
        at: now,
      });
    } catch {
      // An audit write must not turn a delivered notice into a failed request.
    }
  }

  private requestNotice(
    request: Request,
    member: Member,
    at: Date,
    dedupeKey: string,
  ): Notification {
    const what =
      request.kind === "more_budget" && request.amountUsd !== null
        ? `USD ${request.amountUsd.toFixed(2)} more budget`
        : request.kind === "model_unlock" && request.modelId !== null
          ? `access to ${request.modelId}`
          : "a suggestion";
    const reason = request.message.trim() === "" ? "" : ` Reason: ${request.message.trim()}`;
    return this.notice({
      kind: "request_created",
      audience: "manager",
      teamId: request.teamId,
      memberId: member.id,
      title: `New request from ${member.displayName}`,
      body: `${member.displayName} asks for ${what}.${reason}`,
      link: this.link(`/requests?id=${request.id}`),
      dedupeKey,
      at,
    });
  }

  private decisionNotice(
    request: Request,
    member: Member,
    note: string | null,
    at: Date,
    dedupeKey: string,
  ): Notification {
    const outcome =
      request.state === "approved"
        ? "approved"
        : request.state === "partly_approved"
          ? "partly approved"
          : request.state;
    const detail =
      note === null || note.trim() === "" ? "Open My allowance to see the result." : note;
    return this.notice({
      kind: "request_decided",
      audience: "member",
      teamId: request.teamId,
      memberId: member.id,
      title: `Your request was ${outcome}`,
      body: detail,
      link: this.link("/me"),
      dedupeKey,
      at,
    });
  }

  async createRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
    const now = this.clock.now();
    const bundle = await this.loadPolicyBundle(input.memberId, now);

    if (input.kind === "model_unlock") {
      const requested = input.modelId?.trim() ?? "";
      const entry = bundle.catalogue.find((model) => model.id === requested);
      if (entry === undefined || entry.state === "blocked") {
        throw new DomainError("invalid_input", "That model is not in the team catalogue.");
      }
    }

    const request = buildRequest({
      id: this.ids.next("req"),
      member: bundle.member,
      kind: input.kind,
      message: input.message,
      context: await this.contextFor(bundle, now),
      now,
      ...(input.amountUsd === undefined ? {} : { amountUsd: input.amountUsd }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    });

    const rules = await this.store.listRules(bundle.member.teamId);
    const match = findMatchingRule({ request, rules, grants: bundle.grants, now });

    let decided: ReturnType<typeof decideRequest> | null = null;
    let ruleActor: AuditActor | null = null;
    let ruleReason: string | null = null;
    if (match !== null) {
      const decider = {
        type: "rule" as const,
        id: match.rule.id,
        role: "rule" as const,
        source: "rule" as const,
      };
      decided = decideRequest(
        request,
        {
          outcome: "approved",
          note: ruleNote(match),
          ...(match.amountUsd === null ? {} : { amountUsd: match.amountUsd }),
          ...(match.modelId === null ? {} : { modelId: match.modelId }),
          ...(match.until === null ? {} : { until: match.until }),
        },
        decider,
        this.decisionOptions(bundle, now),
      );
      ruleActor = makeActor("rule", match.rule.id, match.rule.name);
      ruleReason = ruleNote(match);
    }

    await this.store.transaction(async () => {
      await this.store.createRequest(request);
      await this.trail.record({
        actor: memberActor(bundle.member),
        action: AUDIT_ACTIONS.requestCreated,
        objectType: "request",
        objectId: request.id,
        before: null,
        after: request,
        at: now,
      });

      if (decided !== null && ruleActor !== null) {
        await this.store.addDecision(decided.decision);
        await this.store.setRequestState(decided.request.id, decided.request.state, toIso(now));
        await this.trail.record({
          actor: ruleActor,
          action: AUDIT_ACTIONS.requestDecided,
          objectType: "request",
          objectId: request.id,
          before: request,
          after: decided.request,
          reason: ruleReason,
          at: now,
        });
        if (decided.grant !== null) {
          await this.store.addGrant(decided.grant);
          await this.trail.record({
            actor: ruleActor,
            action: AUDIT_ACTIONS.grantIssued,
            objectType: "grant",
            objectId: decided.grant.id,
            before: null,
            after: decided.grant,
            reason: ruleReason,
            at: now,
          });
        }
      }
    });

    await this.reconcile();

    await this.deliver(
      this.requestNotice(request, bundle.member, now, `request_created:${request.id}`),
      bundle.teamPolicy,
      now,
    );
    if (decided !== null) {
      await this.deliver(
        this.decisionNotice(
          decided.request,
          bundle.member,
          decided.decision.note,
          now,
          `request_decided:${request.id}`,
        ),
        bundle.teamPolicy,
        now,
      );
    }

    return {
      request: decided?.request ?? request,
      decision: decided?.decision ?? null,
      grant: decided?.grant ?? null,
    };
  }

  async decide(
    requestId: string,
    actor: StaffActor,
    input: DecisionInput,
  ): Promise<DecideRequestResult> {
    if (actor.type !== "manager" && actor.type !== "admin") {
      forbidden("Only a manager or an admin can decide a request.");
    }
    const now = this.clock.now();
    const request = await this.store.getRequest(requestId);
    if (request === null) notFound("Unknown request.");
    this.requireSameTeam(actor, request.teamId, "decide a request");

    if (request.state === "pending" && isRequestDue(request, now)) {
      const expired = expireRequest(request);
      await this.store.transaction(async () => {
        await this.store.setRequestState(request.id, "expired", toIso(now));
        await this.trail.record({
          actor: SYSTEM_ACTOR,
          action: AUDIT_ACTIONS.requestExpired,
          objectType: "request",
          objectId: request.id,
          before: request,
          after: expired,
          reason: "72 hours passed without a decision",
          at: now,
        });
      });
      await this.reconcile();
      throw new DomainError("expired", "This request expired before it was decided.");
    }

    const limits = await this.store.getLimits(request.memberId);
    if (limits === null) invalidState("The member has no limits yet.");

    const result = decideRequest(
      request,
      input,
      {
        type: actor.type,
        id: actor.id,
        role: actor.role,
        source: "manager",
        displayName: actor.displayName ?? null,
      },
      {
        now,
        grantId: this.ids.next("grn"),
        decisionId: this.ids.next("dec"),
        budgetPeriod: limits.period,
      },
    );

    await this.store.transaction(async () => {
      await this.store.addDecision(result.decision);
      await this.store.setRequestState(request.id, result.request.state, toIso(now));
      if (result.grant !== null) await this.store.addGrant(result.grant);
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.requestDecided,
        objectType: "request",
        objectId: request.id,
        before: request,
        after: result.request,
        reason: result.decision.note,
        at: now,
      });
      if (result.grant !== null) {
        await this.trail.record({
          actor: staffActor(actor),
          action: AUDIT_ACTIONS.grantIssued,
          objectType: "grant",
          objectId: result.grant.id,
          before: null,
          after: result.grant,
          reason: result.decision.note,
          at: now,
        });
      }
    });

    await this.reconcile();
    const member = await this.store.getMember(request.memberId);
    if (member !== null) {
      const teamPolicy =
        (await this.store.getTeamPolicy(request.teamId)) ?? defaultTeamPolicy(request.teamId, now);
      await this.deliver(
        this.decisionNotice(
          result.request,
          member,
          result.decision.note,
          now,
          `request_decided:${request.id}`,
        ),
        teamPolicy,
        now,
      );
    }
    return result;
  }

  async cancel(requestId: string, memberId: string): Promise<Request> {
    const now = this.clock.now();
    const request = await this.store.getRequest(requestId);
    if (request === null) notFound("Unknown request.");
    if (request.memberId !== memberId) forbidden("A member can only cancel their own request.");
    const cancelled = cancelRequest(request);

    await this.store.transaction(async () => {
      await this.store.setRequestState(request.id, "cancelled", toIso(now));
      const member = await this.store.getMember(memberId);
      await this.trail.record({
        actor: member === null ? makeActor("member", memberId, null) : memberActor(member),
        action: AUDIT_ACTIONS.requestCancelled,
        objectType: "request",
        objectId: request.id,
        before: request,
        after: cancelled,
        reason: null,
        at: now,
      });
    });

    await this.reconcile();
    return cancelled;
  }

  async revokeGrant(grantId: GrantId, actor: StaffActor, reason: string): Promise<Grant> {
    if (actor.type !== "manager" && actor.type !== "admin") {
      forbidden("Only a manager or an admin can revoke a grant.");
    }
    const grant = await this.store.getGrant(grantId);
    if (grant === null) notFound("Unknown grant.");
    const member = await this.store.getMember(grant.memberId);
    if (member === null) notFound("Unknown member.");
    this.requireSameTeam(actor, member.teamId, "revoke a grant");
    if (grant.revokedAt !== null) return grant;

    const now = this.clock.now();
    const revoked: Grant = { ...grant, revokedAt: toIso(now) };
    await this.store.transaction(async () => {
      await this.store.revokeGrant(grant.id, toIso(now));
      await this.trail.record({
        actor: staffActor(actor),
        action: AUDIT_ACTIONS.grantRevoked,
        objectType: "grant",
        objectId: grant.id,
        before: grant,
        after: revoked,
        reason,
        at: now,
      });
    });

    await this.reconcile();
    return revoked;
  }

  /** Expire pending requests past 72 hours and grants past `expiresAt`. */
  async expireDue(actor: AuditActor = SYSTEM_ACTOR): Promise<ExpiryResult> {
    const now = this.clock.now();
    const at = toIso(now);
    const pending = await this.store.listRequests({ state: "pending" });
    const due = pending.filter((request) => isRequestDue(request, now));

    const expiredRequests: Request[] = [];
    for (const request of due) {
      const expired = expireRequest(request);
      await this.store.transaction(async () => {
        await this.store.setRequestState(request.id, "expired", at);
        await this.trail.record({
          actor,
          action: AUDIT_ACTIONS.requestExpired,
          objectType: "request",
          objectId: request.id,
          before: request,
          after: expired,
          reason: "72 hours passed without a decision",
          at: now,
        });
      });
      expiredRequests.push(expired);
    }

    const staleGrants = await this.store.listExpiredGrants(at);
    const expiredGrants: Grant[] = [];
    for (const grant of staleGrants) {
      await this.store.transaction(async () => {
        await this.store.markGrantExpired(grant.id, at);
        await this.trail.record({
          actor,
          action: AUDIT_ACTIONS.grantExpired,
          objectType: "grant",
          objectId: grant.id,
          before: grant,
          after: { ...grant, expiredAt: at },
          reason: "the grant reached its expiry",
          at: now,
        });
      });
      expiredGrants.push(grant);
    }

    const reconcile =
      expiredRequests.length > 0 || expiredGrants.length > 0 ? await this.reconcile() : null;

    return { expiredRequests, expiredGrants, reconcile };
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.reconciler.run();
  }

  startReconciler(options: LoopOptions = {}): ReconciliationLoop {
    const loop = new ReconciliationLoop(this.reconciler, options);
    loop.start();
    return loop;
  }

  /** Expire due requests and grants on a timer, not only when a manager acts. */
  startExpiryLoop(options: ExpiryLoopOptions = {}): ExpiryLoop {
    const loop = new ExpiryLoop(this, options);
    loop.start();
    return loop;
  }
}

export interface ExpiryLoopOptions {
  intervalMs?: number;
  scheduler?: IntervalScheduler;
  onError?: (error: unknown) => void;
}

/**
 * Runs `expireDue()` on an interval. The reconcile loop covers key state; this
 * loop covers the two time-based transitions, so a pending
 * request cannot stay pending forever and an expired grant is recorded even
 * when no manager opens the console.
 */
export class ExpiryLoop {
  private readonly service: ControlService;
  private readonly intervalMs: number;
  private readonly scheduler: IntervalScheduler;
  private readonly onError: ((error: unknown) => void) | undefined;
  private handle: unknown = null;
  private running = false;

  constructor(service: ControlService, options: ExpiryLoopOptions = {}) {
    this.service = service;
    this.intervalMs = options.intervalMs ?? EXPIRY_INTERVAL_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onError = options.onError;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  async tick(): Promise<ExpiryResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.service.expireDue();
    } catch (error) {
      if (this.onError !== undefined) this.onError(error);
      else throw error;
      return null;
    } finally {
      this.running = false;
    }
  }
}
