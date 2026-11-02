/**
 * The control-service port the HTTP layer depends on.
 *
 * The core service (`src/core/`) owns the implementation; the API is
 * tested against a fake that satisfies this interface. Keeping the port here
 * means the API owns its own transport and authorisation, while every use case
 * that touches the store and the gateway stays in one service method.
 *
 * Contract for implementations:
 * - a method that changes state appends exactly one `AuditEvent` with `actor`
 *   before it returns;
 * - an audit `before`/`after` value never contains a key, a key hash, a
 *   password hash or an API token;
 * - a refusal throws a typed `ApiError` (404 unknown object, 409 wrong state,
 *   422 over limit) and writes nothing;
 * - no method returns key material except `createMember` and `rotateKey`,
 *   whose `secret` is shown once.
 */

import type {
  AuditEvent,
  AuditFilter,
  Decision,
  DecisionOutcome,
  EffectivePolicy,
  Grant,
  IsoDateTime,
  Limits,
  Member,
  ModelEntry,
  Period,
  Request,
  RequestFilter,
  RequestKind,
  RequestState,
  Role,
  Rule,
  Team,
  TeamPolicy,
  UsageQuery,
  UsageRow,
} from "../contracts.ts";

export type AuthVia = "member_key" | "manager_token" | "session";

/** The authenticated caller, passed to every state-changing use case. */
export interface Actor {
  memberId: string;
  teamId: string;
  role: Role;
  via: AuthVia;
}

/** One audit row a route appends for an object it created outside a use case. */
export interface RecordAuditInput {
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

/** `GET /api/me` — current member allowance and policy snapshot. */
export interface MeView {
  displayName: string;
  teamName: string;
  policy: EffectivePolicy;
}

export interface TeamAlert {
  kind: string;
  message: string;
  at: IsoDateTime;
}

export interface TeamOverviewMember {
  member: Member;
  policy: EffectivePolicy;
  spendUsd: number;
}

/** `GET /api/team/overview`. */
export interface TeamOverview {
  team: Team;
  members: TeamOverviewMember[];
  models: ModelEntry[];
  openRequests: Request[];
  alerts: TeamAlert[];
}

/** `GET /api/team/members/:id`. */
export interface MemberDetail {
  member: Member;
  policy: EffectivePolicy;
  limits: Limits;
  grants: Grant[];
  usage: UsageRow[];
}

export interface DecisionResult {
  request: Request;
  decision: Decision;
  grant: Grant | null;
}

export interface CreateRequestInput {
  memberId: string;
  teamId: string;
  kind: RequestKind;
  amountUsd: number | null;
  modelId: string | null;
  message: string;
}

export interface DecideRequestInput {
  outcome: DecisionOutcome;
  note: string | null;
  amountUsd: number | null;
  modelId: string | null;
  until: IsoDateTime | null;
  permanent: boolean;
}

export type LimitsPatch = Partial<
  Pick<Limits, "budgetUsd" | "period" | "tokenCap" | "rpm" | "tpm">
>;

export interface CreateMemberInput {
  displayName: string;
  email: string | null;
  role: Role;
  limits?: Limits;
}

export interface CreatedMember extends Member {
  /** Shown once by `POST /api/admin/teams/:id/members`; never stored. */
  secret: string;
}

export interface RotatedKey {
  member: Member;
  secret: string;
}

export interface ConfigBundleFile {
  path: string;
  content: string;
}

/**
 * The per-CLI enrolment bundle. The setup module replaces the stub content with real
 * generated files; the transport and the no-key-in-bundle rule are fixed here.
 */
export interface ConfigBundle {
  memberId: string;
  teamId: string;
  generatedAt: IsoDateTime;
  generator: "stub";
  note: string;
  files: ConfigBundleFile[];
}

export interface QueryWindow {
  from: IsoDateTime;
  to: IsoDateTime;
}

export interface ControlPort {
  getMe(memberId: string): Promise<MeView>;

  listRequests(filter: RequestFilter): Promise<Request[]>;
  getRequest(requestId: string): Promise<Request | null>;
  createRequest(input: CreateRequestInput): Promise<Request>;
  cancelRequest(actor: Actor, requestId: string): Promise<Request>;
  listUsage(query: UsageQuery): Promise<UsageRow[]>;

  getTeamOverview(teamId: string): Promise<TeamOverview>;
  decideRequest(
    actor: Actor,
    requestId: string,
    input: DecideRequestInput,
  ): Promise<DecisionResult>;

  getMember(memberId: string): Promise<Member | null>;
  listMembers(teamId: string): Promise<Member[]>;
  getMemberDetail(teamId: string, memberId: string): Promise<MemberDetail | null>;
  setLimits(
    actor: Actor,
    memberId: string,
    patch: LimitsPatch,
  ): Promise<{ member: Member; policy: EffectivePolicy }>;
  setModels(
    actor: Actor,
    memberId: string,
    modelIds: string[],
  ): Promise<{ member: Member; policy: EffectivePolicy }>;
  blockKey(
    actor: Actor,
    memberId: string,
    reason: string,
  ): Promise<{ member: Member; policy: EffectivePolicy }>;
  unblockKey(actor: Actor, memberId: string): Promise<{ member: Member; policy: EffectivePolicy }>;
  rotateKey(actor: Actor, memberId: string): Promise<RotatedKey>;

  listAudit(teamId: string, filter: AuditFilter): Promise<AuditEvent[]>;
  /** Append one audit event; used by routes whose object has no use case. */
  recordAudit(actor: Actor, input: RecordAuditInput): Promise<void>;
  listRules(teamId: string): Promise<Rule[]>;
  getRule(ruleId: string): Promise<Rule | null>;
  upsertRule(actor: Actor, rule: Rule): Promise<Rule>;
  getTeamPolicy(teamId: string): Promise<TeamPolicy | null>;
  setTeamPolicy(actor: Actor, policy: TeamPolicy): Promise<TeamPolicy>;
  revokeGrant(actor: Actor, grantId: string, reason: string): Promise<Grant>;

  listTeams(): Promise<Team[]>;
  getTeam(teamId: string): Promise<Team | null>;
  createTeam(actor: Actor, input: { name: string; monthlyBudgetUsd: number }): Promise<Team>;
  updateTeam(
    actor: Actor,
    teamId: string,
    patch: { name?: string; monthlyBudgetUsd?: number },
  ): Promise<Team>;
  deleteTeam(actor: Actor, teamId: string): Promise<void>;

  createMember(actor: Actor, teamId: string, input: CreateMemberInput): Promise<CreatedMember>;
  deleteMember(actor: Actor, teamId: string, memberId: string): Promise<void>;

  configBundle(teamId: string, memberId: string): Promise<ConfigBundle>;
}

/** How a route treats the caller's team. */
export interface TeamScope {
  /** The team a scoped route reads or writes. */
  teamId: string;
  /** False when a non-admin manager asked for a different team. */
  allowed: boolean;
}

export type { Period, RequestFilter, RequestState };
