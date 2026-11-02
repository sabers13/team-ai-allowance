/**
 * The control-service adapter: `ControlPort` over the SQLite store and core service.
 *
 * The HTTP layer and the console talk to one `ControlPort`. This file
 * is the only place that translates that port into store reads, service use
 * cases and the gateway calls a member needs when their key is issued,
 * rotated or removed. Every use case that touches the store and the gateway
 * together lives in `src/core/service.ts`; only key lifecycle, which the
 * service does not own, is implemented here.
 */

import type {
  Actor,
  ConfigBundle,
  ControlPort,
  CreatedMember,
  CreateMemberInput,
  CreateRequestInput,
  DecideRequestInput,
  DecisionResult,
  LimitsPatch,
  MeView,
  RecordAuditInput,
  RotatedKey,
  TeamOverview,
} from "../api/index.ts";
import type {
  AuditEvent,
  AuditFilter,
  Clock,
  DecisionOutcome,
  EffectivePolicy,
  GatewayClient,
  Grant,
  Limits,
  Member,
  ModelEntry,
  Request,
  RequestFilter,
  Rule,
  Team,
  TeamPolicy,
  UsageQuery,
  UsageRow,
} from "../contracts.ts";
import {
  AuditTrail,
  budgetDurationFor,
  type ControlService,
  type CoreStore,
  computeEffectivePolicy,
  DomainError,
  defaultTeamPolicy,
  forbidden,
  type IdSource,
  keyAliasForMemberId,
  makeActor,
  notFound,
  periodStart,
  randomIds,
  type StaffActor,
  toIso,
} from "../core/index.ts";
import { GatewayError } from "../gateway/index.ts";
import { generateSetupBundle, type SetupSpec } from "../setup/index.ts";

export interface ControlPortDeps {
  store: CoreStore;
  gateway: GatewayClient;
  service: ControlService;
  clock: Clock;
  ids?: IdSource;
  /** Absolute control-service URL written into a member's config bundle. */
  controlUrl: string;
  /** Gateway origin written into a member's config bundle. */
  gatewayUrl: string;
}

/**
 * The control port plus the one operation that is not part of the frozen port:
 * issuing a key for a member the seed created directly in the store.
 */
export interface ControlPortWithKeys extends ControlPort {
  issueKey(memberId: string): Promise<string>;
}

const USAGE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS: Limits = {
  budgetUsd: 0,
  period: "monthly",
  tokenCap: null,
  rpm: null,
  tpm: null,
};

function staffOf(actor: Actor): StaffActor {
  if (actor.role !== "manager" && actor.role !== "admin") {
    forbidden("Only a manager or an admin can do that.");
  }
  return {
    type: actor.role,
    id: actor.memberId,
    role: actor.role,
    teamId: actor.teamId,
    displayName: null,
  };
}

function requireTeam(member: Member | null, teamId: string): Member {
  if (member === null) notFound("Member not found.");
  if (member.teamId !== teamId) notFound("Member not found.");
  return member;
}

function spendOf(rows: readonly UsageRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + row.costUsd, 0) * 1_000_000) / 1_000_000;
}

export function createControlPort(deps: ControlPortDeps): ControlPortWithKeys {
  const { store, gateway, service, clock } = deps;
  const ids = deps.ids ?? randomIds();
  const trail = new AuditTrail(store, ids, clock);

  async function policyFor(memberId: string, now: Date): Promise<EffectivePolicy> {
    const member = await store.getMember(memberId);
    if (member === null) notFound("Member not found.");
    const limits = (await store.getLimits(memberId)) ?? DEFAULT_LIMITS;
    const teamPolicy =
      (await store.getTeamPolicy(member.teamId)) ?? defaultTeamPolicy(member.teamId, now);
    const from = toIso(periodStart(limits.period, now));
    const usage = await store.listUsage({ memberId, from, to: toIso(now) });
    return computeEffectivePolicy({
      member,
      limits,
      modelSelection: await store.getMemberModels(memberId),
      catalogue: await store.listModels(),
      teamPolicy,
      grants: await store.listGrants(memberId),
      spendThisPeriodUsd: spendOf(usage),
      now,
    });
  }

  async function spendInPeriod(memberId: string, now: Date): Promise<number> {
    const limits = (await store.getLimits(memberId)) ?? DEFAULT_LIMITS;
    const from = toIso(periodStart(limits.period, now));
    const rows = await store.listUsage({ memberId, from, to: toIso(now) });
    return spendOf(rows);
  }

  async function issueKeyFor(member: Member, limits: Limits): Promise<string> {
    const now = clock.now();
    const team = await store.getTeam(member.teamId);
    if (team === null) notFound("Team not found.");
    const policy = await policyFor(member.id, now);
    const created = await gateway.createKey({
      keyAlias: member.keyAlias,
      teamId: await gatewayTeamId(team),
      userId: member.id,
      models: policy.allowedModels,
      maxBudgetUsd: limits.budgetUsd,
      budgetDuration: budgetDurationFor(limits.period),
      tpmLimit: limits.tpm,
      rpmLimit: limits.rpm,
    });
    await store.updateMember(member.id, { keyHash: created.keyHash });
    return created.secret;
  }

  /**
   * The gateway has its own team ids. The mapping is persisted on the team row,
   * so a restart reuses one gateway team instead of creating a duplicate with a
   * fresh budget (`results/dogfood/cleanup.json:116`).
   */
  async function gatewayTeamId(team: Team): Promise<string> {
    const stored = await store.getGatewayTeamId(team.id);
    if (stored !== null) return stored;
    const models = (await store.listModels())
      .filter((model) => model.state !== "blocked")
      .map((model) => model.id);
    const created = await gateway.createTeam({
      name: team.name,
      monthlyBudgetUsd: team.monthlyBudgetUsd,
      modelIds: models,
    });
    await store.setGatewayTeamId(team.id, created);
    return created;
  }

  /** Push the team's name and monthly ceiling to the gateway once it exists. */
  async function syncGatewayTeam(team: Team): Promise<void> {
    const gatewayId = (await store.getGatewayTeamId(team.id)) ?? (await gatewayTeamId(team));
    await gateway.updateTeam(gatewayId, {
      name: team.name,
      monthlyBudgetUsd: team.monthlyBudgetUsd,
    });
  }

  async function isMissingKey(error: unknown): Promise<boolean> {
    return error instanceof GatewayError && error.code === "not_found";
  }

  async function withPolicy(
    memberId: string,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    const member = await store.getMember(memberId);
    if (member === null) notFound("Member not found.");
    return { member, policy: await policyFor(memberId, clock.now()) };
  }

  function bundleFor(team: Team, member: Member, models: ModelEntry[]): ConfigBundle {
    const spec: SetupSpec = {
      team: {
        name: team.name,
        gatewayUrl: deps.gatewayUrl,
        providerId: "team-gateway",
        defaultModel: models[0]?.id ?? "mock-cheap",
        models: models.map((model) => ({ id: model.id, displayName: model.displayName })),
        controlUrl: deps.controlUrl,
        mcp: { command: "taa", args: ["mcp"] },
        pluginPath: null,
        security: {},
      },
      member: { id: member.id, displayName: member.displayName, email: member.email },
    };
    const bundle = generateSetupBundle(spec, "key-not-in-bundle");
    const files = [
      ...bundle.files
        .filter((file) => !file.path.startsWith("member/"))
        .map((file) => ({ path: file.path, content: file.contents })),
      {
        path: "member/taa.env",
        content:
          "# Team AI Allowance member environment.\n" +
          "# The key is shown once when the member is created; it is never part of this bundle.\n" +
          `export TAA_BASE_URL=${deps.controlUrl}\n` +
          "export TAA_MEMBER_KEY=\n",
      },
    ];
    return {
      memberId: member.id,
      teamId: team.id,
      generatedAt: clock.now().toISOString(),
      generator: "stub",
      note: "Generated from the team catalogue. Replace TAA_MEMBER_KEY with the key shown once at enrolment.",
      files,
    };
  }

  return {
    async getMe(memberId: string): Promise<MeView> {
      const member = await store.getMember(memberId);
      if (member === null) notFound("Member not found.");
      const team = await store.getTeam(member.teamId);
      return {
        displayName: member.displayName,
        teamName: team?.name ?? "",
        policy: await policyFor(memberId, clock.now()),
      };
    },

    async listRequests(filter: RequestFilter): Promise<Request[]> {
      if (filter.teamId === undefined && filter.memberId !== undefined) {
        const member = await store.getMember(filter.memberId);
        if (member === null) return [];
        return store.listRequests({ ...filter, teamId: member.teamId });
      }
      return store.listRequests(filter);
    },

    async getRequest(requestId: string): Promise<Request | null> {
      return store.getRequest(requestId);
    },

    async createRequest(input: CreateRequestInput): Promise<Request> {
      const result = await service.createRequest({
        memberId: input.memberId,
        kind: input.kind,
        message: input.message,
        ...(input.amountUsd === null ? {} : { amountUsd: input.amountUsd }),
        ...(input.modelId === null ? {} : { modelId: input.modelId }),
      });
      return result.request;
    },

    async cancelRequest(actor: Actor, requestId: string): Promise<Request> {
      return service.cancel(requestId, actor.memberId);
    },

    async listUsage(query: UsageQuery): Promise<UsageRow[]> {
      if (query.teamId !== undefined && query.memberId === undefined) {
        const members = await store.listMembers(query.teamId);
        const rows: UsageRow[] = [];
        for (const member of members) {
          rows.push(...(await store.listUsage({ ...query, memberId: member.id })));
        }
        return rows.sort((left, right) => left.at.localeCompare(right.at));
      }
      return store.listUsage(query);
    },

    async getTeamOverview(teamId: string): Promise<TeamOverview> {
      const team = await store.getTeam(teamId);
      if (team === null) notFound("Team not found.");
      const now = clock.now();
      const members = await store.listMembers(teamId);
      const rows = [];
      for (const member of members) {
        rows.push({
          member,
          policy: await policyFor(member.id, now),
          spendUsd: await spendInPeriod(member.id, now),
        });
      }
      const openRequests = await store.listRequests({ teamId, state: "pending", limit: 50 });
      const audit = await store.listAudit({ teamId, limit: 8 });
      return {
        team,
        members: rows,
        models: await store.listModels(),
        openRequests,
        alerts: audit.map((event) => ({
          kind: event.action,
          message: `${event.objectType} ${event.objectId}`,
          at: event.at,
        })),
      };
    },

    async decideRequest(
      actor: Actor,
      requestId: string,
      input: DecideRequestInput,
    ): Promise<DecisionResult> {
      const result = await service.decide(requestId, staffOf(actor), {
        outcome: input.outcome,
        note: input.note,
        amountUsd: input.amountUsd,
        modelId: input.modelId,
        until: input.until,
        permanent: input.permanent,
      });
      return { request: result.request, decision: result.decision, grant: result.grant };
    },

    async getMember(memberId: string): Promise<Member | null> {
      return store.getMember(memberId);
    },

    async revokeGrant(actor: Actor, grantId: string, reason: string): Promise<Grant> {
      const grant = await service.revokeGrant(grantId, staffOf(actor), reason);
      return grant;
    },

    async listMembers(teamId: string): Promise<Member[]> {
      return store.listMembers(teamId);
    },

    async getMemberDetail(teamId: string, memberId: string) {
      const member = requireTeam(await store.getMember(memberId), teamId);
      const now = clock.now();
      const from = new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS).toISOString();
      return {
        member,
        policy: await policyFor(memberId, now),
        limits: (await store.getLimits(memberId)) ?? DEFAULT_LIMITS,
        grants: await store.listGrants(memberId),
        usage: await store.listUsage({ memberId, from, to: toIso(now) }),
      };
    },

    async setLimits(actor: Actor, memberId: string, patch: LimitsPatch) {
      const current = (await store.getLimits(memberId)) ?? DEFAULT_LIMITS;
      const next: Limits = {
        budgetUsd: patch.budgetUsd ?? current.budgetUsd,
        period: patch.period ?? current.period,
        tokenCap: patch.tokenCap === undefined ? current.tokenCap : patch.tokenCap,
        rpm: patch.rpm === undefined ? current.rpm : patch.rpm,
        tpm: patch.tpm === undefined ? current.tpm : patch.tpm,
      };
      await service.setMemberLimits(memberId, next, staffOf(actor));
      return withPolicy(memberId);
    },

    async setModels(actor: Actor, memberId: string, modelIds: string[]) {
      await service.setMemberModels(memberId, modelIds, staffOf(actor));
      return withPolicy(memberId);
    },

    async blockKey(actor: Actor, memberId: string, reason: string) {
      await service.setMemberBlocked(memberId, true, staffOf(actor), reason);
      return withPolicy(memberId);
    },

    async unblockKey(actor: Actor, memberId: string) {
      await service.setMemberBlocked(memberId, false, staffOf(actor), null);
      return withPolicy(memberId);
    },

    async rotateKey(actor: Actor, memberId: string): Promise<RotatedKey> {
      const staff = staffOf(actor);
      const member = await store.getMember(memberId);
      if (member === null) notFound("Member not found.");
      if (staff.type !== "admin" && member.teamId !== staff.teamId) {
        forbidden("A manager cannot rotate a key in another team.");
      }
      const rotated = await gateway.regenerateKey({
        keyAlias: member.keyAlias,
        keyHash: member.keyHash ?? member.keyAlias,
      });
      const now = clock.now();
      const updated = await store.updateMember(memberId, { keyHash: rotated.keyHash });
      await trail.record({
        actor: makeActor(staff.type, staff.id, staff.displayName ?? null),
        action: "key.rotated",
        objectType: "member",
        objectId: memberId,
        before: { keyAlias: member.keyAlias },
        after: { keyAlias: updated.keyAlias },
        reason: null,
        at: now,
      });
      await service.reconcile();
      return { member: updated, secret: rotated.secret };
    },

    async listAudit(_teamId: string, filter: AuditFilter): Promise<AuditEvent[]> {
      return store.listAudit(filter);
    },

    async recordAudit(actor: Actor, input: RecordAuditInput): Promise<void> {
      const staff = staffOf(actor);
      await trail.record({
        actor: makeActor(staff.type, staff.id, staff.displayName ?? null),
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        before: input.before,
        after: input.after,
        reason: input.reason,
        at: clock.now(),
      });
    },

    async listRules(teamId: string): Promise<Rule[]> {
      return store.listRules(teamId);
    },

    async getRule(ruleId: string): Promise<Rule | null> {
      return store.getRule(ruleId);
    },

    async upsertRule(actor: Actor, rule: Rule): Promise<Rule> {
      return service.upsertRule(
        { ...rule, createdAt: rule.createdAt === "" ? clock.now().toISOString() : rule.createdAt },
        staffOf(actor),
      );
    },

    async getTeamPolicy(teamId: string): Promise<TeamPolicy | null> {
      return store.getTeamPolicy(teamId);
    },

    async setTeamPolicy(actor: Actor, policy: TeamPolicy): Promise<TeamPolicy> {
      return service.setTeamPolicy(policy, staffOf(actor));
    },

    async listTeams(): Promise<Team[]> {
      return store.listTeams();
    },

    async getTeam(teamId: string): Promise<Team | null> {
      return store.getTeam(teamId);
    },

    async createTeam(actor: Actor, input: { name: string; monthlyBudgetUsd: number }) {
      const staff = staffOf(actor);
      if (staff.type !== "admin") forbidden("Only an admin can create a team.");
      const now = clock.now();
      const team = await store.createTeam({
        name: input.name,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
      });
      try {
        await gatewayTeamId(team);
      } catch (error) {
        // The gateway team is the ceiling the plan promises. Do not leave a
        // local team that silently has none.
        await store.deleteTeam(team.id);
        throw error;
      }
      await trail.record({
        actor: makeActor("admin", staff.id, null),
        action: "team.created",
        objectType: "team",
        objectId: team.id,
        before: null,
        after: team,
        reason: null,
        at: now,
      });
      return team;
    },

    async updateTeam(actor: Actor, teamId: string, patch) {
      const staff = staffOf(actor);
      if (staff.type !== "admin") forbidden("Only an admin can change a team.");
      const before = await store.getTeam(teamId);
      if (before === null) notFound("Team not found.");
      const team = await store.updateTeam(teamId, patch);
      await syncGatewayTeam(team);
      await trail.record({
        actor: makeActor("admin", staff.id, null),
        action: "team.updated",
        objectType: "team",
        objectId: teamId,
        before,
        after: team,
        reason: null,
        at: clock.now(),
      });
      return team;
    },

    async deleteTeam(actor: Actor, teamId: string): Promise<void> {
      const staff = staffOf(actor);
      if (staff.type !== "admin") forbidden("Only an admin can delete a team.");
      const before = await store.getTeam(teamId);
      if (before === null) notFound("Team not found.");
      // Offboarding first: a deleted team must not leave working keys behind.
      for (const member of await store.listMembers(teamId)) {
        try {
          await gateway.deleteKey({ keyAlias: member.keyAlias, keyHash: member.keyHash ?? "" });
        } catch (error) {
          if (!(await isMissingKey(error))) throw error;
        }
      }
      const gatewayId = await store.getGatewayTeamId(teamId);
      if (gatewayId !== null) {
        try {
          await gateway.deleteTeam(gatewayId);
        } catch (error) {
          if (!(await isMissingKey(error))) throw error;
        }
      }
      await store.deleteTeam(teamId);
      await trail.record({
        actor: makeActor("admin", staff.id, null),
        action: "team.deleted",
        objectType: "team",
        objectId: teamId,
        before,
        after: null,
        reason: null,
        at: clock.now(),
      });
    },

    async createMember(
      actor: Actor,
      teamId: string,
      input: CreateMemberInput,
    ): Promise<CreatedMember> {
      const staff = staffOf(actor);
      if (staff.type !== "admin") {
        if (staff.teamId !== teamId) {
          forbidden("A manager can only enrol into their own team.");
        }
        if (input.role !== "member") {
          forbidden("Only an admin can create a manager or an admin.");
        }
      }
      const team = await store.getTeam(teamId);
      if (team === null) notFound("Team not found.");
      const limits = input.limits ?? DEFAULT_LIMITS;
      const now = clock.now();
      const inserted = await store.createMember({
        teamId,
        displayName: input.displayName,
        email: input.email,
        role: input.role,
        keyAlias: `taa-${ids.next("mem")}`,
        keyHash: null,
        blocked: false,
        blockedReason: null,
      });
      // The alias must name the row's own id, which the store assigns.
      const member = await store.updateMember(inserted.id, {
        keyAlias: keyAliasForMemberId(inserted.id),
      });
      await store.setLimits(member.id, limits);
      await trail.record({
        actor: makeActor("admin", staff.id, null),
        action: "member.created",
        objectType: "member",
        objectId: member.id,
        before: null,
        after: { id: member.id, displayName: member.displayName, role: member.role },
        reason: null,
        at: now,
      });
      const secret = await issueKeyFor(member, limits);
      const withKey = await store.getMember(member.id);
      if (withKey === null) notFound("Member not found.");
      await service.reconcile();
      return { ...withKey, secret };
    },

    async issueKey(memberId: string): Promise<string> {
      const member = await store.getMember(memberId);
      if (member === null) notFound("Member not found.");
      const limits = (await store.getLimits(memberId)) ?? DEFAULT_LIMITS;
      const secret = await issueKeyFor(member, limits);
      await service.reconcile();
      return secret;
    },

    async deleteMember(actor: Actor, teamId: string, memberId: string): Promise<void> {
      const staff = staffOf(actor);
      if (staff.type !== "admin") forbidden("Only an admin can delete a member.");
      const member = requireTeam(await store.getMember(memberId), teamId);
      try {
        await gateway.deleteKey({ keyAlias: member.keyAlias, keyHash: member.keyHash ?? "" });
      } catch (error) {
        // A key that is already gone (revoked by hand, or never created) is the
        // state deletion wants, not a failure.
        if (!(await isMissingKey(error)) && !(error instanceof DomainError)) throw error;
      }
      await store.deleteMember(memberId);
      await trail.record({
        actor: makeActor("admin", staff.id, null),
        action: "member.deleted",
        objectType: "member",
        objectId: memberId,
        before: { id: member.id, displayName: member.displayName },
        after: null,
        reason: null,
        at: clock.now(),
      });
    },

    async configBundle(teamId: string, memberId: string): Promise<ConfigBundle> {
      const team = await store.getTeam(teamId);
      if (team === null) notFound("Team not found.");
      const member = requireTeam(await store.getMember(memberId), teamId);
      return bundleFor(team, member, await store.listModels());
    },
  };
}

/** The decision outcomes the console may post. */
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = [
  "approved",
  "partly_approved",
  "denied",
];

/** Exported for tests that need the same default an unconfigured member gets. */
export { DEFAULT_LIMITS };
