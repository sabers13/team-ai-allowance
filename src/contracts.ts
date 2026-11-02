/**
 * Frozen domain contracts for team-ai-allowance.
 *
 * Shared domain, store, gateway and API contracts implemented across the modules.
 *
 * The types here contain no transport, database or framework detail. Adapters
 * (LiteLLM admin API, SQLite, HTTP, MCP) live in their own modules and map to
 * these shapes.
 */

export type IsoDateTime = string; // ISO 8601 with an explicit offset, e.g. 2026-10-31T09:15:00Z
export type Usd = number; // US dollars, two decimals when displayed

export type TeamId = string;
export type MemberId = string;
export type RequestId = string;
export type GrantId = string;
export type RuleId = string;
export type AuditId = string;
export type KeyAlias = string;
export type KeyHash = string; // sha256 hex of the member key; the key itself is never stored

export type Role = "admin" | "manager" | "member";

export type Period = "daily" | "weekly" | "monthly";

/** The durations the gateway accepts for a key budget. */
export type GatewayBudgetDuration = "1d" | "7d" | "30d";

export type ModelState = "enabled" | "approval-required" | "blocked";

export type RequestKind = "more_budget" | "model_unlock" | "suggestion";

export type RequestState =
  | "pending"
  | "approved"
  | "partly_approved"
  | "denied"
  | "expired"
  | "cancelled";

export type DecisionOutcome = "approved" | "partly_approved" | "denied";

export type ActorType =
  | "admin"
  | "manager"
  | "member"
  | "rule"
  | "reconciler"
  | "watcher"
  | "system";

export type NotificationKind =
  | "request_created"
  | "request_decided"
  | "soft_limit"
  | "grace"
  | "hard_limit"
  | "off_hours_block"
  | "member_blocked"
  | "grant_expired"
  | "unusual_spend";

export type NotificationChannel = "teams" | "slack" | "email" | "webhook" | "log";

export type Status = "ok" | "soft" | "grace" | "blocked";

export interface Team {
  id: TeamId;
  name: string;
  /** Monthly team budget enforced at the gateway. */
  monthlyBudgetUsd: Usd;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Member {
  id: MemberId;
  teamId: TeamId;
  displayName: string;
  email: string | null;
  role: Role;
  /** Deterministic LiteLLM key alias: `taa-<memberId>`. */
  keyAlias: KeyAlias;
  /** sha256 of the member key; the only key material the control service keeps. */
  keyHash: KeyHash | null;
  blocked: boolean;
  blockedReason: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Limits {
  budgetUsd: Usd;
  period: Period;
  /** Optional watcher-enforced token cap for the same period. */
  tokenCap: number | null;
  rpm: number | null;
  tpm: number | null;
}

export interface ModelEntry {
  /** The model id the gateway serves and the CLI asks for. */
  id: string;
  displayName: string;
  /** Upstream route in LiteLLM form, for example `deepseek/deepseek-v4.1-flash`. */
  route: string;
  inputPer1MUsd: Usd;
  outputPer1MUsd: Usd;
  state: ModelState;
  /** Catalogue order; lower first. */
  sortOrder: number;
}

export type GrantScope = "budget" | "model" | "token_cap";

export interface Grant {
  id: GrantId;
  memberId: MemberId;
  scope: GrantScope;
  /** Budget grant in USD. */
  amountUsd: Usd | null;
  /** Model unlock. */
  modelId: string | null;
  /** Token-cap grant. */
  tokenCap: number | null;
  /** The request that produced it, when there was one. */
  requestId: RequestId | null;
  issuedBy: ActorType;
  issuedById: string | null;
  startsAt: IsoDateTime;
  /** null means permanent until revoked. */
  expiresAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface RequestContext {
  spendThisPeriodUsd: Usd;
  limitUsd: Usd;
  topModels: Array<{ modelId: string; spendUsd: Usd }>;
  last7DaysUsd: Usd;
}

export interface Request {
  id: RequestId;
  memberId: MemberId;
  teamId: TeamId;
  kind: RequestKind;
  /** `more_budget` amount. */
  amountUsd: Usd | null;
  /** `model_unlock` target. */
  modelId: string | null;
  /** The member's words, free text, never model output. */
  message: string;
  state: RequestState;
  context: RequestContext;
  createdAt: IsoDateTime;
  /** Pending requests expire after 72 hours. */
  expiresAt: IsoDateTime;
  decidedAt: IsoDateTime | null;
}

export interface Decision {
  id: string;
  requestId: RequestId;
  outcome: DecisionOutcome;
  /** Manager/admin user id, or the rule id when `source` is `rule`. */
  decidedById: string;
  decidedByRole: Role | "rule";
  note: string | null;
  grantedAmountUsd: Usd | null;
  grantedModelId: string | null;
  grantExpiresAt: IsoDateTime | null;
  grantId: GrantId | null;
  source: "manager" | "rule";
  decidedAt: IsoDateTime;
}

export type RuleCondition =
  | { kind: "budget_topup"; maxUsd: Usd; oncePerDays: number }
  | { kind: "model_unlock"; modelIds: string[]; durationHours: number };

export interface Rule {
  id: RuleId;
  teamId: TeamId;
  name: string;
  enabled: boolean;
  condition: RuleCondition;
  createdAt: IsoDateTime;
}

export interface OffHoursPolicy {
  enabled: boolean;
  /** IANA zone, for example `Europe/Berlin`. */
  timeZone: string;
  /** ISO weekday numbers, 1 = Monday ... 7 = Sunday. */
  workingDays: number[];
  /** Minutes from midnight, inclusive start. */
  startMinute: number;
  /** Minutes from midnight, exclusive end. */
  endMinute: number;
  /** `YYYY-MM-DD` dates treated as non-working. */
  holidays: string[];
  capUsd: Usd;
}

export interface Thresholds {
  /** Fraction of the budget at which a soft notice is sent, default 0.8. */
  softRatio: number;
  /** Extra fraction allowed past 100%, default 0.05. */
  graceRatio: number;
}

export interface NotificationChannelConfig {
  channel: NotificationChannel;
  /** Opaque per-channel settings; secrets are referenced by env var name, never stored. */
  config: Record<string, string>;
  enabled: boolean;
}

export interface TeamPolicy {
  teamId: TeamId;
  offHours: OffHoursPolicy;
  thresholds: Thresholds;
  /** Minimum spend in one window before an unusual-spend alert, default USD 2. */
  unusualSpendMinUsd: Usd;
  notifications: NotificationChannelConfig[];
  updatedAt: IsoDateTime;
}

export interface EffectivePolicy {
  memberId: MemberId;
  allowedModels: string[];
  limits: Limits;
  /** Active grants only; expired and revoked grants are filtered out. */
  grants: Grant[];
  blocked: boolean;
  blockedReason: string | null;
  /** Sum of the period budget plus active budget grants. */
  effectiveBudgetUsd: Usd;
  /** Token cap plus active token-cap grants. */
  effectiveTokenCap: number | null;
  status: Status;
  computedAt: IsoDateTime;
}

export interface DesiredKeyState {
  keyAlias: KeyAlias;
  models: string[];
  maxBudgetUsd: Usd;
  budgetDuration: GatewayBudgetDuration;
  tpmLimit: number | null;
  rpmLimit: number | null;
  blocked: boolean;
}

/**
 * The API shape a request used. The CLI is inferred from it, never observed:
 * Claude Code speaks Anthropic Messages, OpenCode the Responses API and Codex
 * Chat Completions. `unknown` is an honest "we cannot tell".
 */
export type ApiFormat = "anthropic_messages" | "responses" | "chat_completions" | "unknown";

export interface UsageRow {
  id: string;
  memberId: MemberId;
  modelId: string;
  at: IsoDateTime;
  inputTokens: number;
  outputTokens: number;
  costUsd: Usd;
  /** Gateway request id, when the row came from a spend log. */
  requestId: string | null;
  /**
   * The route recorded by the gateway. Optional because rows written before
   * the API-format column existed have no value; the console says "inferred"
   * for every CLI it derives from this field.
   */
  apiFormat?: ApiFormat;
}

export interface AuditActor {
  type: ActorType;
  /** User id, rule id or service name. */
  id: string | null;
  displayName: string | null;
}

export interface AuditEvent {
  id: AuditId;
  at: IsoDateTime;
  actor: AuditActor;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface Notification {
  id: string;
  at: IsoDateTime;
  kind: NotificationKind;
  audience: "member" | "manager";
  teamId: TeamId;
  memberId: MemberId | null;
  title: string;
  body: string;
  link: string | null;
  /** Stable key so a retry does not send the same notice twice. */
  dedupeKey: string;
}

export interface DeliveryResult {
  channel: NotificationChannel;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface Clock {
  now(): Date;
}

export interface GatewayKeyRef {
  keyAlias: KeyAlias;
  keyHash: KeyHash;
}

export interface CreatedGatewayKey {
  keyAlias: KeyAlias;
  keyHash: KeyHash;
  /** Returned once by the gateway and shown once to the member; never persisted. */
  secret: string;
}

export interface CreateGatewayKeyInput {
  keyAlias: KeyAlias;
  teamId: string;
  userId: string;
  models: string[];
  maxBudgetUsd: Usd;
  budgetDuration: GatewayBudgetDuration;
  tpmLimit: number | null;
  rpmLimit: number | null;
}

export interface SpendQuery {
  from: IsoDateTime;
  to: IsoDateTime;
  keyHash?: KeyHash;
  teamId?: string;
}

export interface GatewaySpendRow {
  requestId: string;
  keyHash: string;
  teamId: string | null;
  userId: string | null;
  model: string;
  spendUsd: Usd;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime | null;
  /** LiteLLM `call_type`, narrowed to the API shape the client used. */
  apiFormat?: ApiFormat;
}

/**
 * The LiteLLM admin surface this project uses. The gateway client implements it;
 * every other module depends only on this interface.
 */
export interface GatewayClient {
  createKey(input: CreateGatewayKeyInput): Promise<CreatedGatewayKey>;
  updateKey(ref: GatewayKeyRef, desired: DesiredKeyState): Promise<void>;
  deleteKey(ref: GatewayKeyRef): Promise<void>;
  blockKey(ref: GatewayKeyRef): Promise<void>;
  unblockKey(ref: GatewayKeyRef): Promise<void>;
  regenerateKey(ref: GatewayKeyRef): Promise<CreatedGatewayKey>;
  createTeam(input: { name: string; monthlyBudgetUsd: Usd; modelIds: string[] }): Promise<string>;
  updateTeam(teamId: string, patch: { name?: string; monthlyBudgetUsd?: Usd }): Promise<void>;
  deleteTeam(teamId: string): Promise<void>;
  addTeamMember(teamId: string, userId: string, role: Role): Promise<void>;
  removeTeamMember(teamId: string, userId: string): Promise<void>;
  listSpend(query: SpendQuery): Promise<GatewaySpendRow[]>;
  healthy(): Promise<boolean>;
}

export interface RequestFilter {
  teamId?: TeamId;
  memberId?: MemberId;
  state?: RequestState;
  limit?: number;
}

export interface UsageQuery {
  memberId?: MemberId;
  teamId?: TeamId;
  from: IsoDateTime;
  to: IsoDateTime;
  modelId?: string;
}

export interface AuditFilter {
  teamId?: TeamId;
  actorId?: string;
  objectType?: string;
  objectId?: string;
  from?: IsoDateTime;
  to?: IsoDateTime;
  limit?: number;
}

/**
 * Persistence boundary implemented over SQLite. Callers never write SQL
 * outside their own store adapter.
 */
export interface Store {
  getTeam(id: TeamId): Promise<Team | null>;
  listTeams(): Promise<Team[]>;
  createTeam(input: Omit<Team, "id" | "createdAt" | "updatedAt">): Promise<Team>;
  updateTeam(id: TeamId, patch: Partial<Omit<Team, "id" | "createdAt">>): Promise<Team>;
  deleteTeam(id: TeamId): Promise<void>;

  getMember(id: MemberId): Promise<Member | null>;
  getMemberByKeyHash(hash: KeyHash): Promise<Member | null>;
  listMembers(teamId: TeamId): Promise<Member[]>;
  createMember(input: Omit<Member, "id" | "createdAt" | "updatedAt">): Promise<Member>;
  updateMember(id: MemberId, patch: Partial<Omit<Member, "id" | "createdAt">>): Promise<Member>;
  deleteMember(id: MemberId): Promise<void>;

  getLimits(memberId: MemberId): Promise<Limits | null>;
  setLimits(memberId: MemberId, limits: Limits): Promise<Limits>;

  listGrants(memberId: MemberId, at?: IsoDateTime): Promise<Grant[]>;
  addGrant(grant: Grant): Promise<Grant>;
  revokeGrant(id: GrantId, at: IsoDateTime): Promise<void>;

  getRequest(id: RequestId): Promise<Request | null>;
  listRequests(filter: RequestFilter): Promise<Request[]>;
  createRequest(request: Request): Promise<Request>;
  setRequestState(id: RequestId, state: RequestState, at: IsoDateTime): Promise<Request>;
  addDecision(decision: Decision): Promise<Decision>;
  listDecisions(requestId: RequestId): Promise<Decision[]>;

  listRules(teamId: TeamId): Promise<Rule[]>;
  upsertRule(rule: Rule): Promise<Rule>;
  deleteRule(id: RuleId): Promise<void>;

  getTeamPolicy(teamId: TeamId): Promise<TeamPolicy | null>;
  setTeamPolicy(policy: TeamPolicy): Promise<TeamPolicy>;

  recordUsage(rows: UsageRow[]): Promise<void>;
  listUsage(query: UsageQuery): Promise<UsageRow[]>;

  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(filter: AuditFilter): Promise<AuditEvent[]>;
}

export interface Notifier {
  send(notification: Notification): Promise<DeliveryResult[]>;
}

export const DEFAULT_SOFT_RATIO = 0.8;
export const DEFAULT_GRACE_RATIO = 0.05;
export const DEFAULT_OFF_HOURS_CAP_USD = 5;
export const DEFAULT_UNUSUAL_SPEND_MIN_USD = 2;
export const REQUEST_TTL_HOURS = 72;
/** The reconciler runs after every change and on this interval. */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** The watcher polls spend on this interval by default. */
export const WATCH_INTERVAL_MS = 30 * 1000;
