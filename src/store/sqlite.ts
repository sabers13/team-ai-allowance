import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApiFormat,
  AuditEvent,
  AuditFilter,
  Clock,
  Decision,
  DesiredKeyState,
  GatewayBudgetDuration,
  Grant,
  GrantId,
  IsoDateTime,
  KeyAlias,
  KeyHash,
  Limits,
  Member,
  MemberId,
  ModelEntry,
  ModelState,
  Period,
  Request,
  RequestFilter,
  RequestState,
  Role,
  Rule,
  RuleCondition,
  Team,
  TeamId,
  TeamPolicy,
  UsageQuery,
  UsageRow,
} from "../contracts.ts";
import { stripAuditSecrets } from "../core/audit.ts";
import { systemClock } from "../core/clock.ts";
import { notFound } from "../core/errors.ts";
import type { CoreStore } from "../core/ports.ts";
import { resolveDbPath } from "./config.ts";
import { migrate, SCHEMA_VERSION } from "./migrations.ts";

/**
 * SQLite store for the control service (`node:sqlite`).
 *
 * - One file, migrations from `migrations.ts`.
 * - `transaction()` wraps a unit of work; the callback must not await real I/O.
 * - The audit table rejects UPDATE and DELETE with triggers.
 * - Prompt and response text are never columns here: usage rows hold ids,
 *   counts and cost only.
 */

interface TeamRow {
  id: string;
  name: string;
  monthly_budget_usd: number;
  created_at: string;
  updated_at: string;
  gateway_team_id: string | null;
}

interface MemberRow {
  id: string;
  team_id: string;
  display_name: string;
  email: string | null;
  role: Role;
  key_alias: string;
  key_hash: string | null;
  blocked: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface LimitsRow {
  member_id: string;
  budget_usd: number;
  period: Period;
  token_cap: number | null;
  rpm: number | null;
  tpm: number | null;
}

interface GrantRow {
  id: string;
  member_id: string;
  scope: Grant["scope"];
  amount_usd: number | null;
  model_id: string | null;
  token_cap: number | null;
  request_id: string | null;
  issued_by: Grant["issuedBy"];
  issued_by_id: string | null;
  starts_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface RequestRow {
  id: string;
  member_id: string;
  team_id: string;
  kind: Request["kind"];
  amount_usd: number | null;
  model_id: string | null;
  message: string;
  state: RequestState;
  spend_this_period_usd: number;
  limit_usd: number;
  top_models_json: string;
  last7_days_usd: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

interface DecisionRow {
  id: string;
  request_id: string;
  outcome: Decision["outcome"];
  decided_by_id: string;
  decided_by_role: string;
  note: string | null;
  granted_amount_usd: number | null;
  granted_model_id: string | null;
  grant_expires_at: string | null;
  grant_id: string | null;
  source: Decision["source"];
  decided_at: string;
}

interface RuleRow {
  id: string;
  team_id: string;
  name: string;
  enabled: number;
  condition_kind: string;
  condition_json: string;
  created_at: string;
}

interface PolicyRow {
  team_id: string;
  off_hours_json: string;
  soft_ratio: number;
  grace_ratio: number;
  unusual_spend_min_usd: number;
  notifications_json: string;
  updated_at: string;
}

interface UsageRowDb {
  id: string;
  member_id: string;
  model_id: string;
  at: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  request_id: string | null;
  api_format: string | null;
}

interface AuditRow {
  id: string;
  at: string;
  actor_type: AuditEvent["actor"]["type"];
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  object_type: string;
  object_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
}

interface ModelRow {
  id: string;
  display_name: string;
  route: string;
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  state: ModelState;
  sort_order: number;
}

interface KeyStateRow {
  key_alias: string;
  models_json: string;
  max_budget_usd: number;
  budget_duration: GatewayBudgetDuration;
  tpm_limit: number | null;
  rpm_limit: number | null;
  blocked: number;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    monthlyBudgetUsd: row.monthly_budget_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    teamId: row.team_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    keyAlias: row.key_alias,
    keyHash: row.key_hash,
    blocked: row.blocked === 1,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLimits(row: LimitsRow): Limits {
  return {
    budgetUsd: row.budget_usd,
    period: row.period,
    tokenCap: row.token_cap,
    rpm: row.rpm,
    tpm: row.tpm,
  };
}

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    memberId: row.member_id,
    scope: row.scope,
    amountUsd: row.amount_usd,
    modelId: row.model_id,
    tokenCap: row.token_cap,
    requestId: row.request_id,
    issuedBy: row.issued_by,
    issuedById: row.issued_by_id,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function toRequest(row: RequestRow): Request {
  return {
    id: row.id,
    memberId: row.member_id,
    teamId: row.team_id,
    kind: row.kind,
    amountUsd: row.amount_usd,
    modelId: row.model_id,
    message: row.message,
    state: row.state,
    context: {
      spendThisPeriodUsd: row.spend_this_period_usd,
      limitUsd: row.limit_usd,
      topModels: JSON.parse(row.top_models_json) as Request["context"]["topModels"],
      last7DaysUsd: row.last7_days_usd,
    },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    requestId: row.request_id,
    outcome: row.outcome,
    decidedById: row.decided_by_id,
    decidedByRole: row.decided_by_role as Decision["decidedByRole"],
    note: row.note,
    grantedAmountUsd: row.granted_amount_usd,
    grantedModelId: row.granted_model_id,
    grantExpiresAt: row.grant_expires_at,
    grantId: row.grant_id,
    source: row.source,
    decidedAt: row.decided_at,
  };
}

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    enabled: row.enabled === 1,
    condition: JSON.parse(row.condition_json) as RuleCondition,
    createdAt: row.created_at,
  };
}

function toTeamPolicy(row: PolicyRow): TeamPolicy {
  return {
    teamId: row.team_id,
    offHours: JSON.parse(row.off_hours_json) as TeamPolicy["offHours"],
    thresholds: { softRatio: row.soft_ratio, graceRatio: row.grace_ratio },
    unusualSpendMinUsd: row.unusual_spend_min_usd,
    notifications: JSON.parse(row.notifications_json) as TeamPolicy["notifications"],
    updatedAt: row.updated_at,
  };
}

const API_FORMATS = new Set<ApiFormat>([
  "anthropic_messages",
  "responses",
  "chat_completions",
  "unknown",
]);

function parseApiFormat(value: string | null): ApiFormat | undefined {
  if (value === null) return undefined;
  return API_FORMATS.has(value as ApiFormat) ? (value as ApiFormat) : "unknown";
}

function toUsageRow(row: UsageRowDb): UsageRow {
  const apiFormat = parseApiFormat(row.api_format);
  return {
    id: row.id,
    memberId: row.member_id,
    modelId: row.model_id,
    at: row.at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    requestId: row.request_id,
    ...(apiFormat === undefined ? {} : { apiFormat }),
  };
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normaliseInstant(value: IsoDateTime): IsoDateTime {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function teamIdFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const teamId = (value as { teamId?: unknown }).teamId;
  return typeof teamId === "string" ? teamId : null;
}

function memberIdFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const memberId = (value as { memberId?: unknown }).memberId;
  return typeof memberId === "string" ? memberId : null;
}

function keyAliasFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const keyAlias = (value as { keyAlias?: unknown }).keyAlias;
  return typeof keyAlias === "string" ? keyAlias : null;
}

function toKeyState(row: KeyStateRow): DesiredKeyState {
  return {
    keyAlias: row.key_alias,
    models: JSON.parse(row.models_json) as string[],
    maxBudgetUsd: row.max_budget_usd,
    budgetDuration: row.budget_duration,
    tpmLimit: row.tpm_limit,
    rpmLimit: row.rpm_limit,
    blocked: row.blocked === 1,
  };
}

export interface OpenStoreOptions {
  path?: string;
  clock?: Clock;
}

export class SqliteStore implements CoreStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private depth = 0;

  constructor(db: DatabaseSync, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  /** The migration version this file is on. */
  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  }

  close(): void {
    this.db.close();
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const depth = this.depth;
    if (depth === 0) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT sp_${depth}`);
    this.depth = depth + 1;
    try {
      const result = await fn();
      if (depth === 0) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE sp_${depth}`);
      this.depth = depth;
      return result;
    } catch (error) {
      if (depth === 0) this.db.exec("ROLLBACK");
      else {
        this.db.exec(`ROLLBACK TO sp_${depth}`);
        this.db.exec(`RELEASE sp_${depth}`);
      }
      this.depth = depth;
      throw error;
    }
  }

  // ---------------------------------------------------------------- teams

  async getTeam(id: TeamId): Promise<Team | null> {
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamRow | undefined;
    return row === undefined ? null : toTeam(row);
  }

  async listTeams(): Promise<Team[]> {
    const rows = this.db
      .prepare("SELECT * FROM teams ORDER BY created_at, id")
      .all() as unknown as TeamRow[];
    return rows.map(toTeam);
  }

  async createTeam(input: Omit<Team, "id" | "createdAt" | "updatedAt">): Promise<Team> {
    const now = this.clock.now().toISOString();
    const team: Team = {
      id: `team_${randomUUID()}`,
      name: input.name,
      monthlyBudgetUsd: input.monthlyBudgetUsd,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO teams (id, name, monthly_budget_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(team.id, team.name, team.monthlyBudgetUsd, team.createdAt, team.updatedAt);
    return team;
  }

  async updateTeam(id: TeamId, patch: Partial<Omit<Team, "id" | "createdAt">>): Promise<Team> {
    const current = await this.getTeam(id);
    if (current === null) notFound("Unknown team.");
    const next: Team = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: patch.monthlyBudgetUsd }),
      updatedAt: this.clock.now().toISOString(),
    };
    this.db
      .prepare("UPDATE teams SET name = ?, monthly_budget_usd = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.monthlyBudgetUsd, next.updatedAt, id);
    return next;
  }

  async deleteTeam(id: TeamId): Promise<void> {
    const result = this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    if (Number(result.changes) === 0) notFound("Unknown team.");
  }

  async getGatewayTeamId(id: TeamId): Promise<string | null> {
    const row = this.db.prepare("SELECT gateway_team_id FROM teams WHERE id = ?").get(id) as
      | { gateway_team_id: string | null }
      | undefined;
    return row?.gateway_team_id ?? null;
  }

  async setGatewayTeamId(id: TeamId, gatewayTeamId: string | null): Promise<void> {
    const result = this.db
      .prepare("UPDATE teams SET gateway_team_id = ? WHERE id = ?")
      .run(gatewayTeamId, id);
    if (Number(result.changes) === 0) notFound("Unknown team.");
  }

  // -------------------------------------------------------------- members

  async getMember(id: MemberId): Promise<Member | null> {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as
      | MemberRow
      | undefined;
    return row === undefined ? null : toMember(row);
  }

  async getMemberByKeyHash(hash: KeyHash): Promise<Member | null> {
    const row = this.db.prepare("SELECT * FROM members WHERE key_hash = ?").get(hash) as
      | MemberRow
      | undefined;
    return row === undefined ? null : toMember(row);
  }

  async listMembers(teamId: TeamId): Promise<Member[]> {
    const rows = this.db
      .prepare("SELECT * FROM members WHERE team_id = ? ORDER BY display_name, id")
      .all(teamId) as unknown as MemberRow[];
    return rows.map(toMember);
  }

  async createMember(input: Omit<Member, "id" | "createdAt" | "updatedAt">): Promise<Member> {
    const now = this.clock.now().toISOString();
    const member: Member = {
      ...input,
      id: `mem_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO members
          (id, team_id, display_name, email, role, key_alias, key_hash, blocked, blocked_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        member.id,
        member.teamId,
        member.displayName,
        member.email,
        member.role,
        member.keyAlias,
        member.keyHash,
        member.blocked ? 1 : 0,
        member.blockedReason,
        member.createdAt,
        member.updatedAt,
      );
    return member;
  }

  async updateMember(
    id: MemberId,
    patch: Partial<Omit<Member, "id" | "createdAt">>,
  ): Promise<Member> {
    const current = await this.getMember(id);
    if (current === null) notFound("Unknown member.");
    const next: Member = {
      ...current,
      ...(patch.teamId === undefined ? {} : { teamId: patch.teamId }),
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.email === undefined ? {} : { email: patch.email }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.keyAlias === undefined ? {} : { keyAlias: patch.keyAlias }),
      ...(patch.keyHash === undefined ? {} : { keyHash: patch.keyHash }),
      ...(patch.blocked === undefined ? {} : { blocked: patch.blocked }),
      ...(patch.blockedReason === undefined ? {} : { blockedReason: patch.blockedReason }),
      updatedAt: this.clock.now().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE members SET team_id = ?, display_name = ?, email = ?, role = ?, key_alias = ?,
           key_hash = ?, blocked = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.teamId,
        next.displayName,
        next.email,
        next.role,
        next.keyAlias,
        next.keyHash,
        next.blocked ? 1 : 0,
        next.blockedReason,
        next.updatedAt,
        id,
      );
    return next;
  }

  async deleteMember(id: MemberId): Promise<void> {
    const result = this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
    if (Number(result.changes) === 0) notFound("Unknown member.");
  }

  // --------------------------------------------------------------- limits

  async getLimits(memberId: MemberId): Promise<Limits | null> {
    const row = this.db.prepare("SELECT * FROM member_limits WHERE member_id = ?").get(memberId) as
      | LimitsRow
      | undefined;
    return row === undefined ? null : toLimits(row);
  }

  async setLimits(memberId: MemberId, limits: Limits): Promise<Limits> {
    this.db
      .prepare(
        `INSERT INTO member_limits (member_id, budget_usd, period, token_cap, rpm, tpm)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET
           budget_usd = excluded.budget_usd,
           period = excluded.period,
           token_cap = excluded.token_cap,
           rpm = excluded.rpm,
           tpm = excluded.tpm`,
      )
      .run(memberId, limits.budgetUsd, limits.period, limits.tokenCap, limits.rpm, limits.tpm);
    return limits;
  }

  async getMemberModels(memberId: MemberId): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT model_id FROM member_models WHERE member_id = ? ORDER BY model_id")
      .all(memberId) as Array<{ model_id: string }>;
    return rows.map((row) => row.model_id);
  }

  async setMemberModels(
    memberId: MemberId,
    modelIds: string[],
    _at: IsoDateTime,
  ): Promise<string[]> {
    const unique = [...new Set(modelIds)].sort();
    await this.transaction(() => {
      this.db.prepare("DELETE FROM member_models WHERE member_id = ?").run(memberId);
      const insert = this.db.prepare(
        "INSERT INTO member_models (member_id, model_id) VALUES (?, ?)",
      );
      for (const modelId of unique) insert.run(memberId, modelId);
    });
    return unique;
  }

  // --------------------------------------------------------------- models

  async listModels(): Promise<ModelEntry[]> {
    const rows = this.db
      .prepare("SELECT * FROM models ORDER BY sort_order, id")
      .all() as unknown as ModelRow[];
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      route: row.route,
      inputPer1MUsd: row.input_per_1m_usd,
      outputPer1MUsd: row.output_per_1m_usd,
      state: row.state,
      sortOrder: row.sort_order,
    }));
  }

  async upsertModel(model: ModelEntry): Promise<ModelEntry> {
    this.db
      .prepare(
        `INSERT INTO models (id, display_name, route, input_per_1m_usd, output_per_1m_usd, state, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           route = excluded.route,
           input_per_1m_usd = excluded.input_per_1m_usd,
           output_per_1m_usd = excluded.output_per_1m_usd,
           state = excluded.state,
           sort_order = excluded.sort_order`,
      )
      .run(
        model.id,
        model.displayName,
        model.route,
        model.inputPer1MUsd,
        model.outputPer1MUsd,
        model.state,
        model.sortOrder,
      );
    return model;
  }

  async deleteModel(id: string): Promise<void> {
    const result = this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
    if (Number(result.changes) === 0) notFound("Unknown model.");
  }

  // --------------------------------------------------------------- grants

  async getGrant(id: GrantId): Promise<Grant | null> {
    const row = this.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as
      | GrantRow
      | undefined;
    return row === undefined ? null : toGrant(row);
  }

  async listGrants(memberId: MemberId, at?: IsoDateTime): Promise<Grant[]> {
    if (at === undefined) {
      const rows = this.db
        .prepare("SELECT * FROM grants WHERE member_id = ? ORDER BY created_at DESC, id")
        .all(memberId) as unknown as GrantRow[];
      return rows.map(toGrant);
    }
    const instant = normaliseInstant(at);
    const rows = this.db
      .prepare(
        `SELECT * FROM grants
         WHERE member_id = ? AND revoked_at IS NULL AND starts_at <= ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id`,
      )
      .all(memberId, instant, instant) as unknown as GrantRow[];
    return rows.map(toGrant);
  }

  async addGrant(grant: Grant): Promise<Grant> {
    this.db
      .prepare(
        `INSERT INTO grants
          (id, member_id, scope, amount_usd, model_id, token_cap, request_id, issued_by,
           issued_by_id, starts_at, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.memberId,
        grant.scope,
        grant.amountUsd,
        grant.modelId,
        grant.tokenCap,
        grant.requestId,
        grant.issuedBy,
        grant.issuedById,
        grant.startsAt,
        grant.expiresAt,
        grant.revokedAt,
        grant.createdAt,
      );
    return grant;
  }

  async revokeGrant(id: GrantId, at: IsoDateTime): Promise<void> {
    const result = this.db
      .prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(normaliseInstant(at), id);
    if (Number(result.changes) === 0) {
      const existing = await this.getGrant(id);
      if (existing === null) notFound("Unknown grant.");
    }
  }

  async listExpiredGrants(at: IsoDateTime): Promise<Grant[]> {
    const instant = normaliseInstant(at);
    const rows = this.db
      .prepare(
        `SELECT g.* FROM grants g
         WHERE g.expires_at IS NOT NULL AND g.expires_at <= ? AND g.revoked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM grant_expiry_log l WHERE l.grant_id = g.id)
         ORDER BY g.expires_at, g.id`,
      )
      .all(instant) as unknown as GrantRow[];
    return rows.map(toGrant);
  }

  async markGrantExpired(id: GrantId, at: IsoDateTime): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO grant_expiry_log (grant_id, at) VALUES (?, ?)")
      .run(id, normaliseInstant(at));
  }

  // ------------------------------------------------------------- requests

  async getRequest(id: string): Promise<Request | null> {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as
      | RequestRow
      | undefined;
    return row === undefined ? null : toRequest(row);
  }

  async listRequests(filter: RequestFilter): Promise<Request[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.teamId !== undefined) {
      clauses.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.memberId !== undefined) {
      clauses.push("member_id = ?");
      params.push(filter.memberId);
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const limit =
      filter.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.min(1000, filter.limit))}`;
    const rows = this.db
      .prepare(`SELECT * FROM requests${where} ORDER BY created_at DESC, id${limit}`)
      .all(...params) as unknown as RequestRow[];
    return rows.map(toRequest);
  }

  async createRequest(request: Request): Promise<Request> {
    this.db
      .prepare(
        `INSERT INTO requests
          (id, member_id, team_id, kind, amount_usd, model_id, message, state,
           spend_this_period_usd, limit_usd, top_models_json, last7_days_usd,
           created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.memberId,
        request.teamId,
        request.kind,
        request.amountUsd,
        request.modelId,
        request.message,
        request.state,
        request.context.spendThisPeriodUsd,
        request.context.limitUsd,
        JSON.stringify(request.context.topModels),
        request.context.last7DaysUsd,
        request.createdAt,
        request.expiresAt,
        request.decidedAt,
      );
    return request;
  }

  async setRequestState(id: string, state: RequestState, at: IsoDateTime): Promise<Request> {
    const decided = state === "approved" || state === "partly_approved" || state === "denied";
    const result = this.db
      .prepare(
        `UPDATE requests SET state = ?,
           decided_at = CASE WHEN ? = 1 THEN ? ELSE decided_at END
         WHERE id = ?`,
      )
      .run(state, decided ? 1 : 0, normaliseInstant(at), id);
    if (Number(result.changes) === 0) notFound("Unknown request.");
    const updated = await this.getRequest(id);
    if (updated === null) notFound("Unknown request.");
    return updated;
  }

  async addDecision(decision: Decision): Promise<Decision> {
    this.db
      .prepare(
        `INSERT INTO decisions
          (id, request_id, outcome, decided_by_id, decided_by_role, note,
           granted_amount_usd, granted_model_id, grant_expires_at, grant_id, source, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.requestId,
        decision.outcome,
        decision.decidedById,
        decision.decidedByRole,
        decision.note,
        decision.grantedAmountUsd,
        decision.grantedModelId,
        decision.grantExpiresAt,
        decision.grantId,
        decision.source,
        decision.decidedAt,
      );
    return decision;
  }

  async listDecisions(requestId: string): Promise<Decision[]> {
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE request_id = ? ORDER BY decided_at, id")
      .all(requestId) as unknown as DecisionRow[];
    return rows.map(toDecision);
  }

  // ---------------------------------------------------------------- rules

  async listRules(teamId: TeamId): Promise<Rule[]> {
    const rows = this.db
      .prepare("SELECT * FROM rules WHERE team_id = ? ORDER BY created_at, id")
      .all(teamId) as unknown as RuleRow[];
    return rows.map(toRule);
  }

  async getRule(id: string): Promise<Rule | null> {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
    return row === undefined ? null : toRule(row);
  }

  async upsertRule(rule: Rule): Promise<Rule> {
    this.db
      .prepare(
        `INSERT INTO rules (id, team_id, name, enabled, condition_kind, condition_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           team_id = excluded.team_id,
           name = excluded.name,
           enabled = excluded.enabled,
           condition_kind = excluded.condition_kind,
           condition_json = excluded.condition_json`,
      )
      .run(
        rule.id,
        rule.teamId,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.condition.kind,
        JSON.stringify(rule.condition),
        rule.createdAt,
      );
    return rule;
  }

  async deleteRule(id: string): Promise<void> {
    const result = this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
    if (Number(result.changes) === 0) notFound("Unknown rule.");
  }

  // --------------------------------------------------------------- policy

  async getTeamPolicy(teamId: TeamId): Promise<TeamPolicy | null> {
    const row = this.db.prepare("SELECT * FROM team_policies WHERE team_id = ?").get(teamId) as
      | PolicyRow
      | undefined;
    return row === undefined ? null : toTeamPolicy(row);
  }

  async setTeamPolicy(policy: TeamPolicy): Promise<TeamPolicy> {
    this.db
      .prepare(
        `INSERT INTO team_policies
          (team_id, off_hours_json, soft_ratio, grace_ratio, unusual_spend_min_usd, notifications_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET
           off_hours_json = excluded.off_hours_json,
           soft_ratio = excluded.soft_ratio,
           grace_ratio = excluded.grace_ratio,
           unusual_spend_min_usd = excluded.unusual_spend_min_usd,
           notifications_json = excluded.notifications_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        policy.teamId,
        JSON.stringify(policy.offHours),
        policy.thresholds.softRatio,
        policy.thresholds.graceRatio,
        policy.unusualSpendMinUsd,
        JSON.stringify(policy.notifications),
        policy.updatedAt,
      );
    return policy;
  }

  // ---------------------------------------------------------------- usage

  async recordUsage(rows: UsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO usage_rows
          (id, member_id, model_id, at, input_tokens, output_tokens, cost_usd, request_id, api_format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          row.id,
          row.memberId,
          row.modelId,
          normaliseInstant(row.at),
          row.inputTokens,
          row.outputTokens,
          row.costUsd,
          row.requestId,
          row.apiFormat ?? null,
        );
      }
    });
  }

  async listUsage(query: UsageQuery): Promise<UsageRow[]> {
    const clauses: string[] = ["u.at >= ?", "u.at <= ?"];
    const params: Array<string | number> = [
      normaliseInstant(query.from),
      normaliseInstant(query.to),
    ];
    if (query.memberId !== undefined) {
      clauses.push("u.member_id = ?");
      params.push(query.memberId);
    }
    if (query.teamId !== undefined) {
      clauses.push("m.team_id = ?");
      params.push(query.teamId);
    }
    if (query.modelId !== undefined) {
      clauses.push("u.model_id = ?");
      params.push(query.modelId);
    }
    const rows = this.db
      .prepare(
        `SELECT u.* FROM usage_rows u JOIN members m ON m.id = u.member_id
         WHERE ${clauses.join(" AND ")} ORDER BY u.at, u.id`,
      )
      .all(...params) as unknown as UsageRowDb[];
    return rows.map(toUsageRow);
  }

  // ---------------------------------------------------------------- audit

  private teamIdForMember(memberId: string | null): string | null {
    if (memberId === null) return null;
    const row = this.db.prepare("SELECT team_id FROM members WHERE id = ?").get(memberId) as
      | { team_id: string }
      | undefined;
    return row?.team_id ?? null;
  }

  private teamIdForKeyAlias(keyAlias: string | null): string | null {
    if (keyAlias === null) return null;
    const row = this.db.prepare("SELECT team_id FROM members WHERE key_alias = ?").get(keyAlias) as
      | { team_id: string }
      | undefined;
    return row?.team_id ?? null;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    const objectMemberId =
      event.objectType === "member" || event.objectType === "limits" ? event.objectId : null;
    const teamId =
      teamIdFrom(event.after) ??
      teamIdFrom(event.before) ??
      this.teamIdForMember(memberIdFrom(event.after)) ??
      this.teamIdForMember(memberIdFrom(event.before)) ??
      this.teamIdForMember(objectMemberId) ??
      this.teamIdForKeyAlias(keyAliasFrom(event.after)) ??
      this.teamIdForKeyAlias(keyAliasFrom(event.before));
    this.db
      .prepare(
        `INSERT INTO audit_events
          (id, at, actor_type, actor_id, actor_name, action, object_type, object_id,
           before_json, after_json, reason, team_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        normaliseInstant(event.at),
        event.actor.type,
        event.actor.id,
        event.actor.displayName,
        event.action,
        event.objectType,
        event.objectId,
        jsonOrNull(event.before),
        jsonOrNull(event.after),
        event.reason,
        teamId,
      );
  }

  async listAudit(filter: AuditFilter): Promise<AuditEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.teamId !== undefined) {
      clauses.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.actorId !== undefined) {
      clauses.push("actor_id = ?");
      params.push(filter.actorId);
    }
    if (filter.objectType !== undefined) {
      clauses.push("object_type = ?");
      params.push(filter.objectType);
    }
    if (filter.objectId !== undefined) {
      clauses.push("object_id = ?");
      params.push(filter.objectId);
    }
    if (filter.from !== undefined) {
      clauses.push("at >= ?");
      params.push(normaliseInstant(filter.from));
    }
    if (filter.to !== undefined) {
      clauses.push("at <= ?");
      params.push(normaliseInstant(filter.to));
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    if (filter.limit === undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM audit_events${where} ORDER BY seq`)
        .all(...params) as unknown as AuditRow[];
      return rows.map(toAuditEvent);
    }
    const limit = Math.max(1, Math.min(1000, filter.limit));
    const rows = this.db
      .prepare(`SELECT * FROM audit_events${where} ORDER BY seq DESC LIMIT ${limit}`)
      .all(...params) as unknown as AuditRow[];
    return rows.reverse().map(toAuditEvent);
  }

  // ----------------------------------------------------------- key state

  async getKeyState(keyAlias: KeyAlias): Promise<DesiredKeyState | null> {
    const row = this.db.prepare("SELECT * FROM key_state WHERE key_alias = ?").get(keyAlias) as
      | KeyStateRow
      | undefined;
    return row === undefined ? null : toKeyState(row);
  }

  async listKeyStates(): Promise<DesiredKeyState[]> {
    const rows = this.db
      .prepare("SELECT * FROM key_state ORDER BY key_alias")
      .all() as unknown as KeyStateRow[];
    return rows.map(toKeyState);
  }

  async setKeyState(state: DesiredKeyState, at: IsoDateTime): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO key_state
          (key_alias, models_json, max_budget_usd, budget_duration, tpm_limit, rpm_limit, blocked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_alias) DO UPDATE SET
           models_json = excluded.models_json,
           max_budget_usd = excluded.max_budget_usd,
           budget_duration = excluded.budget_duration,
           tpm_limit = excluded.tpm_limit,
           rpm_limit = excluded.rpm_limit,
           blocked = excluded.blocked,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.keyAlias,
        JSON.stringify([...state.models].sort()),
        state.maxBudgetUsd,
        state.budgetDuration,
        state.tpmLimit,
        state.rpmLimit,
        state.blocked ? 1 : 0,
        normaliseInstant(at),
      );
  }
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    at: row.at,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      displayName: row.actor_name,
    },
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    before: stripAuditSecrets(parseJson(row.before_json)),
    after: stripAuditSecrets(parseJson(row.after_json)),
    reason: row.reason,
  };
}

/**
 * Open a store, create the directory, enable foreign keys and run migrations.
 * `:memory:` gives a throwaway store for tests.
 */
export function openSqliteStore(options: OpenStoreOptions = {}): SqliteStore {
  const path = options.path ?? resolveDbPath();
  const clock = options.clock ?? systemClock;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db, clock.now().toISOString());
  return new SqliteStore(db, clock);
}

export { SCHEMA_VERSION };
