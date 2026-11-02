/**
 * Fixtures for the API tests.
 *
 * The API is built against the `ControlPort` boundary; this file is the
 * executable contract for the adapter over `ControlService` and
 * SQLite store: one audit event per mutation, typed refusals, and key material
 * returned only by `createMember`/`rotateKey`.
 */

import { type ApiConfig, createApiConfig } from "../../src/api/config.ts";
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
  MemberDetail,
  MeView,
  RecordAuditInput,
  RotatedKey,
  TeamOverview,
} from "../../src/api/control.ts";
import { stubConfigBundle } from "../../src/api/enrolment.ts";
import { conflict, forbidden, notFound } from "../../src/api/errors.ts";
import {
  type CredentialStore,
  createMemoryCredentialStore,
  createMemoryManagerTokenStore,
  hashPassword,
  issueManagerToken,
  type ManagerTokenStore,
  sha256Hex,
} from "../../src/auth/index.ts";
import type {
  AuditEvent,
  AuditFilter,
  Clock,
  Decision,
  EffectivePolicy,
  Grant,
  IsoDateTime,
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
} from "../../src/contracts.ts";

export class FakeClock implements Clock {
  #nowMs: number;

  constructor(start = "2026-10-31T09:00:00.000Z") {
    this.#nowMs = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#nowMs);
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }

  set(iso: string): void {
    this.#nowMs = Date.parse(iso);
  }
}

export interface SeedSecrets {
  managerEmail: string;
  adminEmail: string;
  otherManagerEmail: string;
  managerPassword: string;
  adminPassword: string;
  otherManagerPassword: string;
  memberKey: string;
  memberKeyTwo: string;
  otherMemberKey: string;
  managerKey: string;
}

export const SECRETS: SeedSecrets = {
  managerEmail: "priya@example.com",
  adminEmail: "ada@example.com",
  otherManagerEmail: "noor@example.com",
  managerPassword: "manager-password-1",
  adminPassword: "admin-password-1",
  otherManagerPassword: "other-password-1",
  memberKey: "taa_member_one_0123456789",
  memberKeyTwo: "taa_member_two_0123456789",
  otherMemberKey: "taa_member_other_0123456789",
  managerKey: "taa_member_manager_0123456789",
};

const TEAM_ONE = "team-platform";
const TEAM_TWO = "team-data";
const TEAM_SCRATCH = "team-scratch";

export class FakeStore {
  readonly teams = new Map<string, Team>();
  readonly members = new Map<string, Member>();
  readonly limits = new Map<string, Limits>();
  readonly policies = new Map<string, EffectivePolicy>();
  readonly requests = new Map<string, Request>();
  readonly grants = new Map<string, Grant>();
  readonly rules = new Map<string, Rule>();
  readonly teamPolicies = new Map<string, TeamPolicy>();
  readonly models: ModelEntry[] = [];
  readonly usageRows: UsageRow[] = [];
  readonly audit: Array<{ event: AuditEvent; teamId: string }> = [];
  #sequence = 0;

  nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  async getMember(id: string): Promise<Member | null> {
    return this.members.get(id) ?? null;
  }

  async getMemberByKeyHash(hash: string): Promise<Member | null> {
    for (const member of this.members.values()) {
      if (member.keyHash === hash) return member;
    }
    return null;
  }

  record(
    actor: Actor | null,
    teamId: string,
    action: string,
    objectType: string,
    objectId: string,
    before: unknown,
    after: unknown,
    reason: string | null = null,
  ): void {
    const event: AuditEvent = {
      id: this.nextId("aud"),
      at: new Date().toISOString(),
      actor:
        actor === null
          ? { type: "system", id: null, displayName: null }
          : {
              type: actor.role === "admin" ? "admin" : actor.role,
              id: actor.memberId,
              displayName: null,
            },
      action,
      objectType,
      objectId,
      before,
      after,
      reason,
    };
    this.audit.push({ event, teamId });
  }
}

export class FakeControl implements ControlPort {
  readonly store: FakeStore;
  readonly clock: FakeClock;

  constructor(store: FakeStore, clock: FakeClock) {
    this.store = store;
    this.clock = clock;
  }

  async getMe(memberId: string): Promise<MeView> {
    const member = await this.requireMember(memberId);
    const policy = await this.requirePolicy(memberId);
    const team = this.store.teams.get(member.teamId);
    return { displayName: member.displayName, teamName: team?.name ?? "Unknown", policy };
  }

  async listRequests(filter: RequestFilter): Promise<Request[]> {
    const rows = [...this.store.requests.values()]
      .filter((request) => (filter.teamId === undefined ? true : request.teamId === filter.teamId))
      .filter((request) =>
        filter.memberId === undefined ? true : request.memberId === filter.memberId,
      )
      .filter((request) => (filter.state === undefined ? true : request.state === filter.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }

  async getRequest(requestId: string): Promise<Request | null> {
    return this.store.requests.get(requestId) ?? null;
  }

  async createRequest(input: CreateRequestInput): Promise<Request> {
    const member = await this.requireMember(input.memberId);
    if (member.teamId !== input.teamId) throw forbidden("A member cannot post to another team.");
    const now = this.clock.now();
    const request: Request = {
      id: this.store.nextId("new-req"),
      memberId: member.id,
      teamId: member.teamId,
      kind: input.kind,
      amountUsd: input.amountUsd,
      modelId: input.modelId,
      message: input.message,
      state: "pending",
      context: {
        spendThisPeriodUsd: 3.4,
        limitUsd: 20,
        topModels: [{ modelId: "cheap-model", spendUsd: 2.1 }],
        last7DaysUsd: 7.8,
      },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString(),
      decidedAt: null,
    };
    this.store.requests.set(request.id, request);
    this.store.record(
      { memberId: member.id, teamId: member.teamId, role: "member", via: "member_key" },
      member.teamId,
      "request.create",
      "request",
      request.id,
      null,
      request,
    );
    return request;
  }

  async cancelRequest(actor: Actor, requestId: string): Promise<Request> {
    const request = this.store.requests.get(requestId);
    if (request === undefined) throw notFound("Request not found.");
    if (request.memberId !== actor.memberId && actor.role === "member") {
      throw notFound("Request not found.");
    }
    if (request.state !== "pending") throw conflict("Only a pending request can be cancelled.");
    const updated: Request = {
      ...request,
      state: "cancelled",
      decidedAt: this.clock.now().toISOString(),
    };
    this.store.requests.set(requestId, updated);
    this.store.record(
      actor,
      request.teamId,
      "request.cancel",
      "request",
      requestId,
      request,
      updated,
    );
    return updated;
  }

  async listUsage(query: UsageQuery): Promise<UsageRow[]> {
    return this.store.usageRows.filter((row) => {
      if (query.memberId !== undefined && row.memberId !== query.memberId) return false;
      if (query.modelId !== undefined && row.modelId !== query.modelId) return false;
      if (row.at < query.from || row.at > query.to) return false;
      return true;
    });
  }

  async getTeamOverview(teamId: string): Promise<TeamOverview> {
    const team = await this.requireTeam(teamId);
    const members = await this.listMembers(teamId);
    return {
      team,
      members: await Promise.all(
        members.map(async (member) => ({
          member,
          policy: await this.requirePolicy(member.id),
          spendUsd: 2.5,
        })),
      ),
      models: this.store.models,
      openRequests: await this.listRequests({ teamId, state: "pending" }),
      alerts: [
        {
          kind: "soft_limit",
          message: "Lena reached the soft limit.",
          at: this.clock.now().toISOString(),
        },
      ],
    };
  }

  async decideRequest(
    actor: Actor,
    requestId: string,
    input: DecideRequestInput,
  ): Promise<DecisionResult> {
    const request = this.store.requests.get(requestId);
    if (request === undefined) throw notFound("Request not found.");
    if (actor.role !== "admin" && actor.teamId !== request.teamId) {
      throw forbidden("A manager cannot act on another team.");
    }
    if (request.state !== "pending") throw conflict("This request has already been decided.");
    const now = this.clock.now().toISOString();
    const state =
      input.outcome === "approved"
        ? "approved"
        : input.outcome === "partly_approved"
          ? "partly_approved"
          : "denied";
    const updated: Request = { ...request, state, decidedAt: now };
    this.store.requests.set(requestId, updated);

    const grant: Grant | null =
      input.outcome === "denied"
        ? null
        : {
            id: this.store.nextId("new-grant"),
            memberId: request.memberId,
            scope: request.kind === "model_unlock" ? "model" : "budget",
            amountUsd:
              request.kind === "model_unlock" ? null : (input.amountUsd ?? request.amountUsd),
            modelId: input.modelId ?? request.modelId,
            tokenCap: null,
            requestId: request.id,
            issuedBy: actor.role,
            issuedById: actor.memberId,
            startsAt: now,
            expiresAt: input.permanent ? null : input.until,
            revokedAt: null,
            createdAt: now,
          };
    if (grant !== null) this.store.grants.set(grant.id, grant);

    const decision: Decision = {
      id: this.store.nextId("new-dec"),
      requestId,
      outcome: input.outcome,
      decidedById: actor.memberId,
      decidedByRole: actor.role,
      note: input.note,
      grantedAmountUsd: grant?.amountUsd ?? null,
      grantedModelId: grant?.modelId ?? null,
      grantExpiresAt: grant?.expiresAt ?? null,
      grantId: grant?.id ?? null,
      source: "manager",
      decidedAt: now,
    };
    this.store.record(
      actor,
      request.teamId,
      "request.decide",
      "request",
      requestId,
      request,
      updated,
      input.note,
    );
    return { request: updated, decision, grant };
  }

  async getMember(memberId: string): Promise<Member | null> {
    return this.store.members.get(memberId) ?? null;
  }

  async listMembers(teamId: string): Promise<Member[]> {
    return [...this.store.members.values()].filter((member) => member.teamId === teamId);
  }

  async getMemberDetail(teamId: string, memberId: string): Promise<MemberDetail | null> {
    const member = this.store.members.get(memberId);
    if (member === undefined || member.teamId !== teamId) return null;
    const limits = this.store.limits.get(memberId);
    if (limits === undefined) return null;
    return {
      member,
      policy: await this.requirePolicy(memberId),
      limits,
      grants: [...this.store.grants.values()].filter((grant) => grant.memberId === memberId),
      usage: await this.listUsage({
        memberId,
        from: "2026-01-01T00:00:00.000Z",
        to: "2030-01-01T00:00:00.000Z",
      }),
    };
  }

  async setLimits(
    actor: Actor,
    memberId: string,
    patch: LimitsPatch,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    const member = await this.requireMember(memberId);
    const existing = this.store.limits.get(memberId);
    if (existing === undefined) throw notFound("Limits not found.");
    const limits: Limits = { ...existing, ...patch };
    this.store.limits.set(memberId, limits);
    const policy = await this.recomputePolicy(memberId);
    this.store.record(actor, member.teamId, "member.limits", "member", memberId, existing, limits);
    return { member, policy };
  }

  async setModels(
    actor: Actor,
    memberId: string,
    modelIds: string[],
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    const member = await this.requireMember(memberId);
    const policy = await this.recomputePolicy(memberId, { allowedModels: [...modelIds].sort() });
    this.store.record(actor, member.teamId, "member.models", "member", memberId, null, modelIds);
    return { member, policy };
  }

  async blockKey(
    actor: Actor,
    memberId: string,
    reason: string,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    const member = await this.requireMember(memberId);
    const updated: Member = {
      ...member,
      blocked: true,
      blockedReason: reason,
      updatedAt: this.clock.now().toISOString(),
    };
    this.store.members.set(memberId, updated);
    const policy = await this.recomputePolicy(memberId, {
      blocked: true,
      blockedReason: reason,
      status: "blocked",
    });
    this.store.record(
      actor,
      member.teamId,
      "member.block",
      "member",
      memberId,
      member,
      updated,
      reason,
    );
    return { member: updated, policy };
  }

  async unblockKey(
    actor: Actor,
    memberId: string,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    const member = await this.requireMember(memberId);
    const updated: Member = {
      ...member,
      blocked: false,
      blockedReason: null,
      updatedAt: this.clock.now().toISOString(),
    };
    this.store.members.set(memberId, updated);
    const policy = await this.recomputePolicy(memberId, {
      blocked: false,
      blockedReason: null,
      status: "ok",
    });
    this.store.record(actor, member.teamId, "member.unblock", "member", memberId, member, updated);
    return { member: updated, policy };
  }

  async rotateKey(actor: Actor, memberId: string): Promise<RotatedKey> {
    const member = await this.requireMember(memberId);
    const secret = `taa_member_rotated_${this.store.nextId("secret")}_0123456789`;
    const updated: Member = {
      ...member,
      keyHash: sha256Hex(secret),
      updatedAt: this.clock.now().toISOString(),
    };
    this.store.members.set(memberId, updated);
    this.store.record(actor, member.teamId, "member.rotate", "member", memberId, member, {
      ...updated,
      keyHash: "[redacted]",
    });
    return { member: updated, secret };
  }

  async listAudit(teamId: string, filter: AuditFilter): Promise<AuditEvent[]> {
    return this.store.audit
      .filter((row) => row.teamId === teamId)
      .map((row) => row.event)
      .filter((event) => (filter.actorId === undefined ? true : event.actor.id === filter.actorId))
      .filter((event) =>
        filter.objectType === undefined ? true : event.objectType === filter.objectType,
      )
      .filter((event) =>
        filter.objectId === undefined ? true : event.objectId === filter.objectId,
      )
      .filter((event) => (filter.from === undefined ? true : event.at >= filter.from))
      .filter((event) => (filter.to === undefined ? true : event.at <= filter.to))
      .slice(0, filter.limit ?? 100);
  }

  async recordAudit(actor: Actor, input: RecordAuditInput): Promise<void> {
    this.store.record(
      actor,
      actor.teamId,
      input.action,
      input.objectType,
      input.objectId,
      input.before,
      input.after,
      input.reason,
    );
  }

  async revokeGrant(actor: Actor, grantId: string, reason: string): Promise<Grant> {
    const grant = this.store.grants.get(grantId);
    if (grant === undefined) throw notFound("Grant not found.");
    const member = await this.requireMember(grant.memberId);
    if (actor.role !== "admin" && actor.teamId !== member.teamId) {
      throw forbidden("A manager cannot act on another team.");
    }
    if (grant.revokedAt !== null) return grant;
    const revoked: Grant = { ...grant, revokedAt: this.clock.now().toISOString() };
    this.store.grants.set(grantId, revoked);
    this.store.record(
      actor,
      member.teamId,
      "grant.revoked",
      "grant",
      grantId,
      grant,
      revoked,
      reason,
    );
    return revoked;
  }

  async listRules(teamId: string): Promise<Rule[]> {
    return [...this.store.rules.values()].filter((rule) => rule.teamId === teamId);
  }

  async getRule(ruleId: string): Promise<Rule | null> {
    return this.store.rules.get(ruleId) ?? null;
  }

  async upsertRule(actor: Actor, rule: Rule): Promise<Rule> {
    this.store.rules.set(rule.id, rule);
    this.store.record(actor, rule.teamId, "rule.upsert", "rule", rule.id, null, rule);
    return rule;
  }

  async getTeamPolicy(teamId: string): Promise<TeamPolicy | null> {
    return this.store.teamPolicies.get(teamId) ?? null;
  }

  async setTeamPolicy(actor: Actor, policy: TeamPolicy): Promise<TeamPolicy> {
    const saved: TeamPolicy = { ...policy, updatedAt: this.clock.now().toISOString() };
    this.store.teamPolicies.set(policy.teamId, saved);
    this.store.record(actor, policy.teamId, "team.policy", "team", policy.teamId, null, saved);
    return saved;
  }

  async listTeams(): Promise<Team[]> {
    return [...this.store.teams.values()];
  }

  async getTeam(teamId: string): Promise<Team | null> {
    return this.store.teams.get(teamId) ?? null;
  }

  async createTeam(actor: Actor, input: { name: string; monthlyBudgetUsd: number }): Promise<Team> {
    const now = this.clock.now().toISOString();
    const team: Team = {
      id: this.store.nextId("new-team"),
      name: input.name,
      monthlyBudgetUsd: input.monthlyBudgetUsd,
      createdAt: now,
      updatedAt: now,
    };
    this.store.teams.set(team.id, team);
    this.store.record(actor, team.id, "team.create", "team", team.id, null, team);
    return team;
  }

  async updateTeam(
    actor: Actor,
    teamId: string,
    patch: { name?: string; monthlyBudgetUsd?: number },
  ): Promise<Team> {
    const team = await this.requireTeam(teamId);
    const updated: Team = { ...team, ...patch, updatedAt: this.clock.now().toISOString() };
    this.store.teams.set(teamId, updated);
    this.store.record(actor, teamId, "team.update", "team", teamId, team, updated);
    return updated;
  }

  async deleteTeam(actor: Actor, teamId: string): Promise<void> {
    const team = await this.requireTeam(teamId);
    this.store.teams.delete(teamId);
    for (const [id, member] of this.store.members) {
      if (member.teamId === teamId) this.store.members.delete(id);
    }
    this.store.record(actor, teamId, "team.delete", "team", teamId, team, null);
  }

  async createMember(
    actor: Actor,
    teamId: string,
    input: CreateMemberInput,
  ): Promise<CreatedMember> {
    await this.requireTeam(teamId);
    const now = this.clock.now().toISOString();
    const id = this.store.nextId("new-mem");
    const secret = `taa_member_generated_${id}_0123456789`;
    const member: Member = {
      id,
      teamId,
      displayName: input.displayName,
      email: input.email,
      role: input.role,
      keyAlias: `taa-${id}`,
      keyHash: sha256Hex(secret),
      blocked: false,
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.members.set(id, member);
    const limits: Limits = input.limits ?? {
      budgetUsd: 20,
      period: "weekly",
      tokenCap: null,
      rpm: null,
      tpm: null,
    };
    this.store.limits.set(id, limits);
    this.store.policies.set(id, basePolicy(member, limits, now));
    this.store.record(actor, teamId, "member.create", "member", id, null, {
      ...member,
      keyHash: "[redacted]",
    });
    return { ...member, secret };
  }

  async deleteMember(actor: Actor, teamId: string, memberId: string): Promise<void> {
    const member = await this.requireMember(memberId);
    if (member.teamId !== teamId) throw notFound("Member not found.");
    this.store.members.delete(memberId);
    this.store.limits.delete(memberId);
    this.store.policies.delete(memberId);
    this.store.record(actor, teamId, "member.delete", "member", memberId, member, null);
  }

  async configBundle(teamId: string, memberId: string): Promise<ConfigBundle> {
    const member = await this.requireMember(memberId);
    if (member.teamId !== teamId) throw notFound("Member not found.");
    return stubConfigBundle(member, this.clock);
  }

  async requireMember(memberId: string): Promise<Member> {
    const member = this.store.members.get(memberId);
    if (member === undefined) throw notFound("Member not found.");
    return member;
  }

  async requireTeam(teamId: string): Promise<Team> {
    const team = this.store.teams.get(teamId);
    if (team === undefined) throw notFound("Team not found.");
    return team;
  }

  async requirePolicy(memberId: string): Promise<EffectivePolicy> {
    const policy = this.store.policies.get(memberId);
    if (policy === undefined) throw notFound("Policy not found.");
    return policy;
  }

  async recomputePolicy(
    memberId: string,
    patch: Partial<EffectivePolicy> = {},
  ): Promise<EffectivePolicy> {
    const policy = await this.requirePolicy(memberId);
    const limits = this.store.limits.get(memberId) ?? policy.limits;
    const updated: EffectivePolicy = {
      ...policy,
      ...patch,
      limits,
      effectiveBudgetUsd: limits.budgetUsd,
      computedAt: this.clock.now().toISOString(),
    };
    this.store.policies.set(memberId, updated);
    return updated;
  }
}

function basePolicy(member: Member, limits: Limits, at: IsoDateTime): EffectivePolicy {
  return {
    memberId: member.id,
    allowedModels: ["cheap-model"],
    limits,
    grants: [],
    blocked: false,
    blockedReason: null,
    effectiveBudgetUsd: limits.budgetUsd,
    effectiveTokenCap: limits.tokenCap,
    status: "ok",
    computedAt: at,
  };
}

export interface Fixture {
  control: FakeControl;
  store: FakeStore;
  credentials: CredentialStore;
  tokens: ManagerTokenStore;
  clock: FakeClock;
  config: ApiConfig;
  managerToken: string;
  adminToken: string;
  otherManagerToken: string;
  teamIds: { platform: string; data: string; scratch: string };
  memberIds: {
    manager: string;
    admin: string;
    member: string;
    memberTwo: string;
    otherManager: string;
    rotatable: string;
    deletable: string;
  };
  requestIds: { platform: string; data: string };
}

export async function createFixture(): Promise<Fixture> {
  const store = new FakeStore();
  const clock = new FakeClock();
  const control = new FakeControl(store, clock);
  const credentials = createMemoryCredentialStore(clock);
  const tokens = createMemoryManagerTokenStore();
  const now = clock.now().toISOString();

  const team = (id: string, name: string, budget: number): Team => ({
    id,
    name,
    monthlyBudgetUsd: budget,
    createdAt: now,
    updatedAt: now,
  });
  store.teams.set(TEAM_ONE, team(TEAM_ONE, "Platform", 500));
  store.teams.set(TEAM_TWO, team(TEAM_TWO, "Data", 300));
  store.teams.set(TEAM_SCRATCH, team(TEAM_SCRATCH, "Scratch", 50));

  const makeMember = (
    id: string,
    teamId: string,
    displayName: string,
    role: Member["role"],
    email: string | null,
    keyHash: string | null,
  ): Member => ({
    id,
    teamId,
    displayName,
    email,
    role,
    keyAlias: `taa-${id}`,
    keyHash,
    blocked: false,
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
  });

  const members = {
    manager: makeMember(
      "mgr-1",
      TEAM_ONE,
      "Priya",
      "manager",
      SECRETS.managerEmail,
      sha256Hex(SECRETS.managerKey),
    ),
    admin: makeMember("adm-1", TEAM_ONE, "Ada", "admin", SECRETS.adminEmail, null),
    member: makeMember("mem-1", TEAM_ONE, "Lena", "member", null, sha256Hex(SECRETS.memberKey)),
    memberTwo: makeMember(
      "mem-2",
      TEAM_TWO,
      "Omar",
      "member",
      null,
      sha256Hex(SECRETS.memberKeyTwo),
    ),
    otherManager: makeMember(
      "mgr-2",
      TEAM_TWO,
      "Noor",
      "manager",
      SECRETS.otherManagerEmail,
      sha256Hex(SECRETS.otherMemberKey),
    ),
    rotatable: makeMember(
      "mem-rot",
      TEAM_ONE,
      "Jonas",
      "member",
      null,
      sha256Hex("taa_member_rotatable_0123456789"),
    ),
    deletable: makeMember(
      "mem-del",
      TEAM_ONE,
      "Mika",
      "member",
      null,
      sha256Hex("taa_member_deletable_0123456789"),
    ),
  };
  for (const member of Object.values(members)) {
    store.members.set(member.id, member);
    const limits: Limits = {
      budgetUsd: member.role === "member" ? 20 : 50,
      period: "weekly",
      tokenCap: null,
      rpm: 600,
      tpm: 100_000,
    };
    store.limits.set(member.id, limits);
    store.policies.set(member.id, basePolicy(member, limits, now));
  }

  const managerToken = await issueManagerToken(
    tokens,
    { memberId: members.manager.id, teamId: TEAM_ONE, role: "manager", label: "test manager" },
    clock,
  );
  const adminToken = await issueManagerToken(
    tokens,
    { memberId: members.admin.id, teamId: TEAM_ONE, role: "admin", label: "test admin" },
    clock,
  );
  const otherManagerToken = await issueManagerToken(
    tokens,
    { memberId: members.otherManager.id, teamId: TEAM_TWO, role: "manager", label: "other team" },
    clock,
  );

  await credentials.setPassword(
    members.manager.id,
    SECRETS.managerEmail,
    await hashPassword(SECRETS.managerPassword),
    now,
  );
  await credentials.setPassword(
    members.admin.id,
    SECRETS.adminEmail,
    await hashPassword(SECRETS.adminPassword),
    now,
  );
  await credentials.setPassword(
    members.otherManager.id,
    SECRETS.otherManagerEmail,
    await hashPassword(SECRETS.otherManagerPassword),
    now,
  );

  const request = (
    id: string,
    memberId: string,
    teamId: string,
    kind: Request["kind"],
    amountUsd: number | null,
    modelId: string | null,
    message: string,
  ): Request => ({
    id,
    memberId,
    teamId,
    kind,
    amountUsd,
    modelId,
    message,
    state: "pending",
    context: {
      spendThisPeriodUsd: 3.4,
      limitUsd: 20,
      topModels: [{ modelId: "cheap-model", spendUsd: 2.1 }],
      last7DaysUsd: 7.8,
    },
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 72 * 60 * 60 * 1000).toISOString(),
    decidedAt: null,
  });
  store.requests.set(
    "req-platform",
    request(
      "req-platform",
      "mem-1",
      TEAM_ONE,
      "more_budget",
      5,
      null,
      "Need more for the migration.",
    ),
  );
  store.requests.set(
    "req-data",
    request("req-data", "mem-2", TEAM_TWO, "model_unlock", null, "flagship", "Hard parsing task."),
  );

  store.grants.set("grant-1", {
    id: "grant-1",
    memberId: "mem-1",
    scope: "budget",
    amountUsd: 5,
    modelId: null,
    tokenCap: null,
    requestId: "req-platform",
    issuedBy: "manager",
    issuedById: "mgr-1",
    startsAt: now,
    expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
    revokedAt: null,
    createdAt: now,
  });

  store.rules.set("rule-platform", {
    id: "rule-platform",
    teamId: TEAM_ONE,
    name: "Small top-ups",
    enabled: true,
    condition: { kind: "budget_topup", maxUsd: 2, oncePerDays: 7 },
    createdAt: now,
  });
  store.rules.set("rule-data", {
    id: "rule-data",
    teamId: TEAM_TWO,
    name: "Flagship unlocks",
    enabled: false,
    condition: { kind: "model_unlock", modelIds: ["flagship"], durationHours: 4 },
    createdAt: now,
  });

  const teamPolicy = (teamId: string): TeamPolicy => ({
    teamId,
    offHours: {
      enabled: true,
      timeZone: "Europe/Berlin",
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      holidays: [],
      capUsd: 5,
    },
    thresholds: { softRatio: 0.8, graceRatio: 0.05 },
    unusualSpendMinUsd: 2,
    notifications: [{ channel: "log", config: {}, enabled: true }],
    updatedAt: now,
  });
  store.teamPolicies.set(TEAM_ONE, teamPolicy(TEAM_ONE));
  store.teamPolicies.set(TEAM_TWO, teamPolicy(TEAM_TWO));

  const models: ModelEntry[] = [
    {
      id: "cheap-model",
      displayName: "Cheap",
      route: "mock/cheap-model",
      inputPer1MUsd: 0.1,
      outputPer1MUsd: 0.2,
      state: "enabled",
      sortOrder: 1,
    },
    {
      id: "flagship",
      displayName: "Flagship",
      route: "mock/flagship",
      inputPer1MUsd: 3,
      outputPer1MUsd: 6,
      state: "approval-required",
      sortOrder: 2,
    },
  ];
  store.models.push(...models);

  store.usageRows.push(
    {
      id: "use-1",
      memberId: "mem-1",
      modelId: "cheap-model",
      at: now,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.2,
      requestId: "gw-1",
    },
    {
      id: "use-2",
      memberId: "mem-2",
      modelId: "flagship",
      at: now,
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 9,
      requestId: "gw-2",
    },
  );

  const config = createApiConfig({
    sessionSecret: "test-session-secret-0123456789abcdef",
    csrfSecret: "test-csrf-secret-0123456789abcdef",
    publicUrl: "http://127.0.0.1:18080",
    cookieSecure: false,
  });

  return {
    control,
    store,
    credentials,
    tokens,
    clock,
    config,
    managerToken: managerToken.token,
    adminToken: adminToken.token,
    otherManagerToken: otherManagerToken.token,
    teamIds: { platform: TEAM_ONE, data: TEAM_TWO, scratch: TEAM_SCRATCH },
    memberIds: {
      manager: members.manager.id,
      admin: members.admin.id,
      member: members.member.id,
      memberTwo: members.memberTwo.id,
      otherManager: members.otherManager.id,
      rotatable: members.rotatable.id,
      deletable: members.deletable.id,
    },
    requestIds: { platform: "req-platform", data: "req-data" },
  };
}
