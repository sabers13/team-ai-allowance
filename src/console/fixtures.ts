/**
 * Deterministic fixture data for the console test suite.
 *
 * Every name is invented and every number is generated from a fixed seed, so
 * screenshots and tests are stable. `createFixtureConsole()` returns the data
 * port, the action port and a demo sign-in, all in memory. Nothing here talks to
 * the network and nothing stores prompt or response text.
 */

import { createHash } from "node:crypto";
import type {
  ActorType,
  AuditEvent,
  Decision,
  EffectivePolicy,
  Grant,
  Limits,
  Member,
  ModelEntry,
  Notification,
  Request,
  RequestContext,
  RequestKind,
  Rule,
  Team,
  TeamPolicy,
  UsageRow,
} from "../contracts.ts";
import type {
  ActionReceipt,
  BundleFile,
  ConsoleActions,
  ConsoleAuth,
  ConsoleData,
  DecideInput,
  EnrolInput,
  LimitsInput,
  LoginResult,
  MemberDetail,
  ModelRow,
  ModelsData,
  MyData,
  OverviewData,
  PageSort,
  RequestDetail,
  RequestListFilter,
  SetupData,
  SetupMemberRow,
  Viewer,
} from "./data.ts";
import { ConsoleActionError } from "./data.ts";
import { buildUsageReport } from "./usage/index.ts";

export const FIXTURE_NOW = "2026-10-31T09:15:00Z";
export const FIXTURE_TIME_ZONE = "Europe/Berlin";
export const FIXTURE_CSRF = "fixture-csrf-token";

const NOW_MS = Date.parse(FIXTURE_NOW);
const DAY = 86_400_000;

/** Small deterministic generator; the same seed always gives the same data. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const TEAM: Team = {
  id: "team_platform",
  name: "Platform",
  monthlyBudgetUsd: 1200,
  createdAt: "2026-01-12T09:00:00Z",
  updatedAt: "2026-10-30T16:20:00Z",
};

const MODELS: ModelEntry[] = [
  {
    id: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    route: "deepseek/deepseek-v4.1-flash",
    inputPer1MUsd: 0.15,
    outputPer1MUsd: 0.6,
    state: "enabled",
    sortOrder: 1,
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    route: "openai/gpt-6-luna",
    inputPer1MUsd: 1.1,
    outputPer1MUsd: 4.4,
    state: "enabled",
    sortOrder: 2,
  },
  {
    id: "flagship-9",
    displayName: "Flagship 9",
    route: "openai/flagship-9",
    inputPer1MUsd: 8,
    outputPer1MUsd: 24,
    state: "approval-required",
    sortOrder: 3,
  },
  {
    id: "legacy-max",
    displayName: "Legacy Max",
    route: "openai/legacy-max",
    inputPer1MUsd: 20,
    outputPer1MUsd: 60,
    state: "blocked",
    sortOrder: 4,
  },
];

interface MemberSeed {
  member: Member;
  limits: Limits;
  selectedModels: string[];
  /** Spend target for the budget period, used to scale deterministic usage. */
  targetUsd: number;
  modelMix: string[];
  doctor: Array<{
    cli: "claude-code" | "opencode" | "codex";
    version: string;
    gatewayOk: boolean;
    mcpOk: boolean;
    managedConfig: boolean;
    notes: string[];
  }>;
}

function member(
  id: string,
  displayName: string,
  role: Member["role"],
  email: string,
  blocked = false,
  blockedReason: string | null = null,
): Member {
  return {
    id,
    teamId: TEAM.id,
    displayName,
    email,
    role,
    keyAlias: `taa-${id}`,
    keyHash: createHash("sha256").update(`fixture-key-${id}`).digest("hex"),
    blocked,
    blockedReason,
    createdAt: "2026-02-02T09:00:00Z",
    updatedAt: "2026-10-30T16:20:00Z",
  };
}

const MEMBER_SEEDS: MemberSeed[] = [
  {
    member: member("mem_priya", "Priya", "manager", "priya@example.com"),
    limits: { budgetUsd: 50, period: "monthly", tokenCap: null, rpm: 120, tpm: 400_000 },
    selectedModels: [],
    targetUsd: 22.3,
    modelMix: ["deepseek-v4.1-flash", "gpt-6-luna", "gpt-6-luna"],
    doctor: [
      {
        cli: "claude-code",
        version: "2.1.40",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: true,
        notes: [],
      },
    ],
  },
  {
    member: member("mem_lena", "Lena", "member", "lena@example.com"),
    limits: { budgetUsd: 18, period: "weekly", tokenCap: null, rpm: 60, tpm: 200_000 },
    selectedModels: ["deepseek-v4.1-flash", "gpt-6-luna"],
    targetUsd: 16.8,
    modelMix: ["deepseek-v4.1-flash", "deepseek-v4.1-flash", "gpt-6-luna"],
    doctor: [
      {
        cli: "claude-code",
        version: "2.1.40",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: true,
        notes: [],
      },
      {
        cli: "opencode",
        version: "2.0.3",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: true,
        notes: [],
      },
      {
        cli: "codex",
        version: "0.58.0",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: true,
        notes: ["Managed config is generated, not proven, on this client."],
      },
    ],
  },
  {
    member: member("mem_omar", "Omar", "member", "omar@example.com"),
    limits: { budgetUsd: 40, period: "daily", tokenCap: null, rpm: 60, tpm: 200_000 },
    selectedModels: ["deepseek-v4.1-flash"],
    targetUsd: 12.4,
    modelMix: ["deepseek-v4.1-flash", "gpt-6-luna"],
    doctor: [
      {
        cli: "opencode",
        version: "2.0.3",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: false,
        notes: ["No managed config found in the test home."],
      },
    ],
  },
  {
    member: member("mem_mira", "Mira", "member", "mira@example.com"),
    limits: { budgetUsd: 20, period: "monthly", tokenCap: null, rpm: 60, tpm: 200_000 },
    selectedModels: ["deepseek-v4.1-flash", "gpt-6-luna"],
    targetUsd: 20.8,
    modelMix: ["gpt-6-luna", "gpt-6-luna", "deepseek-v4.1-flash"],
    doctor: [
      {
        cli: "codex",
        version: "0.58.0",
        gatewayOk: true,
        mcpOk: false,
        managedConfig: true,
        notes: ["MCP server not registered for this user."],
      },
    ],
  },
  {
    member: member(
      "mem_jonas",
      "Jonas",
      "member",
      "jonas@example.com",
      true,
      "Off-hours cap of USD 5.00 reached. Unblocks Monday 2 November, 09:00 CET.",
    ),
    limits: { budgetUsd: 15, period: "daily", tokenCap: 300_000, rpm: 60, tpm: 200_000 },
    selectedModels: ["deepseek-v4.1-flash"],
    targetUsd: 4.2,
    modelMix: ["deepseek-v4.1-flash"],
    doctor: [
      {
        cli: "claude-code",
        version: "2.1.40",
        gatewayOk: true,
        mcpOk: true,
        managedConfig: true,
        notes: [],
      },
    ],
  },
];

const TEAM_POLICY: TeamPolicy = {
  teamId: TEAM.id,
  offHours: {
    enabled: true,
    timeZone: FIXTURE_TIME_ZONE,
    workingDays: [1, 2, 3, 4, 5],
    startMinute: 9 * 60,
    endMinute: 18 * 60,
    holidays: ["2026-12-24", "2026-12-25", "2026-12-31"],
    capUsd: 5,
  },
  thresholds: { softRatio: 0.8, graceRatio: 0.05 },
  unusualSpendMinUsd: 2,
  notifications: [
    { channel: "log", config: {}, enabled: true },
    { channel: "slack", config: { webhookEnv: "TAA_SLACK_WEBHOOK" }, enabled: true },
    { channel: "email", config: { smtpEnv: "TAA_SMTP_URL" }, enabled: false },
  ],
  updatedAt: "2026-10-28T14:05:00Z",
};

function periodDays(period: Limits["period"]): number {
  return period === "daily" ? 1 : period === "weekly" ? 7 : 30;
}

interface UsageBuild {
  rows: UsageRow[];
  spendByMember: Map<string, number>;
  monthSpendByMember: Map<string, number>;
}

/** Each fixture member works in one client, so the inferred CLI is stable. */
const API_FORMAT_BY_MEMBER: Readonly<
  Record<string, "anthropic_messages" | "responses" | "chat_completions">
> = {
  mem_priya: "anthropic_messages",
  mem_lena: "anthropic_messages",
  mem_omar: "responses",
  mem_mira: "chat_completions",
  mem_jonas: "responses",
};

function buildUsage(seeds: MemberSeed[]): UsageBuild {
  const rows: UsageRow[] = [];
  const spendByMember = new Map<string, number>();
  const monthSpendByMember = new Map<string, number>();

  for (const [seedIndex, seed] of seeds.entries()) {
    const random = seeded(1000 + seedIndex * 37);
    const days = 60;
    const period = periodDays(seed.limits.period);
    const periodStartDay = days - period;
    const entries: Array<{
      day: number;
      hour: number;
      modelId: string;
      weight: number;
      inPeriod: boolean;
    }> = [];

    for (let day = 0; day < days; day += 1) {
      for (let row = 0; row < 3; row += 1) {
        const modelId = seed.modelMix[(day + row) % seed.modelMix.length] ?? "deepseek-v4.1-flash";
        entries.push({
          day,
          hour: 6 + row,
          modelId,
          weight: 0.4 + random() * 1.2,
          inPeriod: day >= periodStartDay,
        });
      }
    }

    const periodWeight = entries
      .filter((entry) => entry.inPeriod)
      .reduce((sum, entry) => sum + entry.weight, 0);
    const targetCents = Math.round(seed.targetUsd * 100);
    const factor = periodWeight === 0 ? 0 : targetCents / periodWeight;
    const cents = entries.map((entry) => Math.max(0, Math.floor(entry.weight * factor)));

    const indexed = entries.map((entry, index) => ({ entry, index }));
    const periodIndexes = indexed.filter(({ entry }) => entry.inPeriod).map(({ index }) => index);
    let diff = targetCents - periodIndexes.reduce((sum, index) => sum + (cents[index] ?? 0), 0);
    for (let cursor = periodIndexes.length - 1; cursor >= 0 && diff !== 0; cursor -= 1) {
      const index = periodIndexes[cursor];
      if (index === undefined) continue;
      const current = cents[index] ?? 0;
      const delta = diff > 0 ? diff : Math.max(diff, -current);
      cents[index] = current + delta;
      diff -= delta;
    }

    let memberSpend = 0;
    let memberMonth = 0;
    for (const [index, entry] of entries.entries()) {
      const dayMs = NOW_MS - (days - 1 - entry.day) * DAY;
      const at = `${iso(dayMs).slice(0, 10)}T0${entry.hour}:00:00Z`;
      const costUsd = (cents[index] ?? 0) / 100;
      rows.push({
        id: `use_${seed.member.id}_${entry.day}_${entry.hour}`,
        memberId: seed.member.id,
        modelId: entry.modelId,
        at,
        inputTokens: Math.round(costUsd * 400_000),
        outputTokens: Math.round(costUsd * 25_000),
        costUsd,
        requestId: `req_usage_${seed.member.id}_${entry.day}_${entry.hour}`,
        apiFormat: API_FORMAT_BY_MEMBER[seed.member.id] ?? "unknown",
      });
      if (entry.inPeriod) memberSpend += costUsd;
      if (entry.day >= days - 30) memberMonth += costUsd;
    }

    spendByMember.set(seed.member.id, round2(memberSpend));
    monthSpendByMember.set(seed.member.id, round2(memberMonth));
  }

  return { rows, spendByMember, monthSpendByMember };
}

const USAGE = buildUsage(MEMBER_SEEDS);
const SPEND = USAGE.spendByMember;
const MONTH_SPEND = USAGE.monthSpendByMember;

function baseGrants(): Grant[] {
  return [
    {
      id: "grant_lena_budget",
      memberId: "mem_lena",
      scope: "budget",
      amountUsd: 2,
      modelId: null,
      tokenCap: null,
      requestId: null,
      issuedBy: "manager",
      issuedById: "mem_priya",
      startsAt: iso(NOW_MS - 2 * DAY),
      expiresAt: null,
      revokedAt: null,
      createdAt: iso(NOW_MS - 2 * DAY),
    },
    {
      id: "grant_omar_model",
      memberId: "mem_omar",
      scope: "model",
      amountUsd: null,
      modelId: "flagship-9",
      tokenCap: null,
      requestId: "req_0006",
      issuedBy: "manager",
      issuedById: "mem_priya",
      startsAt: iso(NOW_MS - 6 * 3_600_000),
      expiresAt: iso(NOW_MS + 18 * 3_600_000),
      revokedAt: null,
      createdAt: iso(NOW_MS - 6 * 3_600_000),
    },
    {
      id: "grant_mira_tokens",
      memberId: "mem_mira",
      scope: "token_cap",
      amountUsd: null,
      modelId: null,
      tokenCap: 50_000,
      requestId: null,
      issuedBy: "manager",
      issuedById: "mem_priya",
      startsAt: iso(NOW_MS - DAY),
      expiresAt: null,
      revokedAt: null,
      createdAt: iso(NOW_MS - DAY),
    },
  ];
}

function requestContext(memberId: string, limitUsd: number): RequestContext {
  const topModels = ["deepseek-v4.1-flash", "gpt-6-luna"]
    .map((modelId) => ({
      modelId,
      spendUsd: round2(
        USAGE.rows
          .filter(
            (row) =>
              row.memberId === memberId &&
              row.modelId === modelId &&
              Date.parse(row.at) >= NOW_MS - 7 * DAY,
          )
          .reduce((sum, row) => sum + row.costUsd, 0),
      ),
    }))
    .filter((row) => row.spendUsd > 0);
  return {
    spendThisPeriodUsd: SPEND.get(memberId) ?? 0,
    limitUsd,
    topModels,
    last7DaysUsd: round2(
      USAGE.rows
        .filter((row) => row.memberId === memberId && Date.parse(row.at) >= NOW_MS - 7 * DAY)
        .reduce((sum, row) => sum + row.costUsd, 0),
    ),
  };
}

function pendingRequest(input: {
  id: string;
  memberId: string;
  kind: RequestKind;
  amountUsd: number | null;
  modelId: string | null;
  message: string;
  createdAt: number;
  limitUsd: number;
}): Request {
  return {
    id: input.id,
    memberId: input.memberId,
    teamId: TEAM.id,
    kind: input.kind,
    amountUsd: input.amountUsd,
    modelId: input.modelId,
    message: input.message,
    state: "pending",
    context: requestContext(input.memberId, input.limitUsd),
    createdAt: iso(input.createdAt),
    expiresAt: iso(input.createdAt + 72 * 3_600_000),
    decidedAt: null,
  };
}

const BASE_REQUESTS: Request[] = [
  pendingRequest({
    id: "req_0001",
    memberId: "mem_lena",
    kind: "more_budget",
    amountUsd: 10,
    modelId: null,
    message:
      "Finishing the parser refactor; two tests still fail and the weekly budget is nearly gone.",
    createdAt: NOW_MS - 2 * 3_600_000,
    limitUsd: 20,
  }),
  pendingRequest({
    id: "req_0002",
    memberId: "mem_omar",
    kind: "model_unlock",
    amountUsd: null,
    modelId: "flagship-9",
    message:
      "I need stronger reasoning for the migration plan. One hour of the flagship model would do.",
    createdAt: NOW_MS - 30 * 60_000,
    limitUsd: 40,
  }),
  pendingRequest({
    id: "req_0003",
    memberId: "mem_jonas",
    kind: "more_budget",
    amountUsd: 5,
    modelId: null,
    message:
      "The off-hours block stopped a deploy fix. Five dollars would cover the rest of the incident.",
    createdAt: NOW_MS - 5 * 3_600_000,
    limitUsd: 15,
  }),
  pendingRequest({
    id: "req_0004",
    memberId: "mem_mira",
    kind: "suggestion",
    amountUsd: null,
    modelId: null,
    message: "The soft notice should name the reset date, not just the percentage.",
    createdAt: NOW_MS - DAY,
    limitUsd: 20,
  }),
  {
    ...pendingRequest({
      id: "req_0005",
      memberId: "mem_lena",
      kind: "more_budget",
      amountUsd: 10,
      modelId: null,
      message: "Two long tasks in one week; I need a top-up to finish the parser.",
      createdAt: NOW_MS - 8 * DAY,
      limitUsd: 20,
    }),
    state: "approved",
    decidedAt: iso(NOW_MS - 8 * DAY + 40 * 60_000),
  },
  {
    ...pendingRequest({
      id: "req_0006",
      memberId: "mem_omar",
      kind: "model_unlock",
      amountUsd: null,
      modelId: "flagship-9",
      message: "The schema migration needs careful reasoning about edge cases.",
      createdAt: NOW_MS - 3 * DAY,
      limitUsd: 40,
    }),
    state: "partly_approved",
    decidedAt: iso(NOW_MS - 3 * DAY + 25 * 60_000),
  },
  {
    ...pendingRequest({
      id: "req_0007",
      memberId: "mem_jonas",
      kind: "more_budget",
      amountUsd: 5,
      modelId: null,
      message: "One more push to finish the release notes.",
      createdAt: NOW_MS - 6 * DAY,
      limitUsd: 15,
    }),
    state: "denied",
    decidedAt: iso(NOW_MS - 6 * DAY + 90 * 60_000),
  },
  {
    ...pendingRequest({
      id: "req_0008",
      memberId: "mem_mira",
      kind: "more_budget",
      amountUsd: 3,
      modelId: null,
      message: "A small top-up for the last report.",
      createdAt: NOW_MS - 12 * DAY,
      limitUsd: 20,
    }),
    state: "expired",
  },
  {
    ...pendingRequest({
      id: "req_0009",
      memberId: "mem_lena",
      kind: "suggestion",
      amountUsd: null,
      modelId: null,
      message: "Could the weekly reset move to Sunday evening?",
      createdAt: NOW_MS - 4 * DAY,
      limitUsd: 20,
    }),
    state: "cancelled",
    decidedAt: iso(NOW_MS - 4 * DAY + 3_600_000),
  },
];

const BASE_DECISIONS: Decision[] = [
  {
    id: "dec_0005",
    requestId: "req_0005",
    outcome: "approved",
    decidedById: "mem_priya",
    decidedByRole: "manager",
    note: "Approved for this week only. The next request needs a plan.",
    grantedAmountUsd: 10,
    grantedModelId: null,
    grantExpiresAt: iso(NOW_MS - 8 * DAY + 7 * DAY),
    grantId: "grant_hist_lena",
    source: "manager",
    decidedAt: iso(NOW_MS - 8 * DAY + 40 * 60_000),
  },
  {
    id: "dec_0006",
    requestId: "req_0006",
    outcome: "partly_approved",
    decidedById: "mem_priya",
    decidedByRole: "manager",
    note: "Two hours, then back to the enabled model.",
    grantedAmountUsd: null,
    grantedModelId: "flagship-9",
    grantExpiresAt: iso(NOW_MS - 3 * DAY + 2 * 3_600_000),
    grantId: "grant_hist_omar",
    source: "manager",
    decidedAt: iso(NOW_MS - 3 * DAY + 25 * 60_000),
  },
  {
    id: "dec_0007",
    requestId: "req_0007",
    outcome: "denied",
    decidedById: "mem_priya",
    decidedByRole: "manager",
    note: "Finish the current task, commit and report. We can revisit on Monday.",
    grantedAmountUsd: null,
    grantedModelId: null,
    grantExpiresAt: null,
    grantId: null,
    source: "manager",
    decidedAt: iso(NOW_MS - 6 * DAY + 90 * 60_000),
  },
];

const BASE_RULES: Rule[] = [
  {
    id: "rule_topup_small",
    teamId: TEAM.id,
    name: "Small top-up",
    enabled: true,
    condition: { kind: "budget_topup", maxUsd: 2, oncePerDays: 7 },
    createdAt: "2026-09-14T10:00:00Z",
  },
  {
    id: "rule_flagship_short",
    teamId: TEAM.id,
    name: "Flagship for a short task",
    enabled: false,
    condition: { kind: "model_unlock", modelIds: ["flagship-9"], durationHours: 4 },
    createdAt: "2026-09-20T10:00:00Z",
  },
];

function auditEvent(input: {
  id: string;
  at: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}): AuditEvent {
  return {
    id: input.id,
    at: input.at,
    actor: { type: input.actorType, id: input.actorId, displayName: input.actorName },
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    before: input.before,
    after: input.after,
    reason: input.reason,
  };
}

const BASE_AUDIT: AuditEvent[] = [
  auditEvent({
    id: "aud_0009",
    at: iso(NOW_MS - 2 * 3_600_000),
    actorType: "member",
    actorId: "mem_lena",
    actorName: "Lena",
    action: "request.created",
    objectType: "request",
    objectId: "req_0001",
    before: null,
    after: { state: "pending", kind: "more_budget", amountUsd: 10 },
    reason: "Weekly budget nearly gone.",
  }),
  auditEvent({
    id: "aud_0008",
    at: iso(NOW_MS - 5 * 3_600_000),
    actorType: "watcher",
    actorId: "watcher",
    actorName: "Watcher",
    action: "member.blocked",
    objectType: "member",
    objectId: "mem_jonas",
    before: { blocked: false, blockedReason: null },
    after: { blocked: true, blockedReason: "Off-hours cap of USD 5.00 reached." },
    reason: "Off-hours cap",
  }),
  auditEvent({
    id: "aud_0007",
    at: iso(NOW_MS - DAY),
    actorType: "manager",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "grant.created",
    objectType: "grant",
    objectId: "grant_mira_tokens",
    before: null,
    after: { scope: "token_cap", tokenCap: 50_000, expiresAt: null },
    reason: "Long report run approved.",
  }),
  auditEvent({
    id: "aud_0006",
    at: iso(NOW_MS - 2 * DAY),
    actorType: "manager",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "member.limits.updated",
    objectType: "member",
    objectId: "mem_omar",
    before: { budgetUsd: 30, period: "daily", rpm: 60, tpm: 200_000 },
    after: { budgetUsd: 40, period: "daily", rpm: 60, tpm: 200_000 },
    reason: "Migration week.",
  }),
  auditEvent({
    id: "aud_0005",
    at: iso(NOW_MS - 3 * DAY),
    actorType: "manager",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "request.partly_approved",
    objectType: "request",
    objectId: "req_0006",
    before: { state: "pending" },
    after: {
      state: "partly_approved",
      grantedModelId: "flagship-9",
      grantExpiresAt: iso(NOW_MS - 3 * DAY + 2 * 3_600_000),
    },
    reason: "Two hours, then back to the enabled model.",
  }),
  auditEvent({
    id: "aud_0004",
    at: iso(NOW_MS - 4 * DAY),
    actorType: "member",
    actorId: "mem_lena",
    actorName: "Lena",
    action: "request.cancelled",
    objectType: "request",
    objectId: "req_0009",
    before: { state: "pending" },
    after: { state: "cancelled" },
    reason: "Solved it with the current model.",
  }),
  auditEvent({
    id: "aud_0003",
    at: iso(NOW_MS - 6 * DAY),
    actorType: "manager",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "request.denied",
    objectType: "request",
    objectId: "req_0007",
    before: { state: "pending" },
    after: { state: "denied" },
    reason: "Finish the current task, commit and report.",
  }),
  auditEvent({
    id: "aud_0002",
    at: iso(NOW_MS - 8 * DAY),
    actorType: "manager",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "rule.updated",
    objectType: "rule",
    objectId: "rule_topup_small",
    before: { enabled: false, maxUsd: 1 },
    after: { enabled: true, maxUsd: 2, oncePerDays: 7 },
    reason: "Small top-ups are routine.",
  }),
  auditEvent({
    id: "aud_0001",
    at: iso(NOW_MS - 20 * DAY),
    actorType: "admin",
    actorId: "mem_priya",
    actorName: "Priya",
    action: "member.enrolled",
    objectType: "member",
    objectId: "mem_mira",
    before: null,
    after: { displayName: "Mira", role: "member", budgetUsd: 20, period: "monthly" },
    reason: "New team member.",
  }),
];

const BASE_NOTIFICATIONS: Notification[] = [
  {
    id: "not_0004",
    at: iso(NOW_MS - 30 * 60_000),
    kind: "request_created",
    audience: "manager",
    teamId: TEAM.id,
    memberId: "mem_omar",
    title: "Omar asked to unlock Flagship 9.",
    body: "A model request is waiting in the inbox.",
    link: "/requests/req_0002",
    dedupeKey: "request:req_0002",
  },
  {
    id: "not_0003",
    at: iso(NOW_MS - 2 * 3_600_000),
    kind: "soft_limit",
    audience: "member",
    teamId: TEAM.id,
    memberId: "mem_lena",
    title: "Lena passed 80% of the weekly budget.",
    body: "USD 16.80 of USD 20.00 used.",
    link: "/members/mem_lena",
    dedupeKey: "soft:mem_lena:2026-W44",
  },
  {
    id: "not_0002",
    at: iso(NOW_MS - 5 * 3_600_000),
    kind: "off_hours_block",
    audience: "member",
    teamId: TEAM.id,
    memberId: "mem_jonas",
    title: "Jonas is blocked for off-hours spend.",
    body: "The key unblocks at the next working-hours start.",
    link: "/members/mem_jonas",
    dedupeKey: "offhours:mem_jonas:2026-10-31",
  },
  {
    id: "not_0001",
    at: iso(NOW_MS - DAY),
    kind: "unusual_spend",
    audience: "manager",
    teamId: TEAM.id,
    memberId: "mem_mira",
    title: "Unusual spend for Mira.",
    body: "Today is more than three times the 14-day median.",
    link: "/members/mem_mira",
    dedupeKey: "unusual:mem_mira:2026-10-30",
  },
];

interface FixtureState {
  members: Member[];
  limits: Map<string, Limits>;
  selectedModels: Map<string, string[]>;
  grants: Grant[];
  requests: Request[];
  decisions: Decision[];
  rules: Rule[];
  policy: TeamPolicy;
  audit: AuditEvent[];
  notifications: Notification[];
  key: Map<string, { blocked: boolean; reason: string | null; lastRotatedAt: string | null }>;
  nextMember: number;
  nextRequest: number;
  nextId: number;
}

function createState(): FixtureState {
  return {
    members: MEMBER_SEEDS.map((seed) => ({ ...seed.member })),
    limits: new Map(MEMBER_SEEDS.map((seed) => [seed.member.id, { ...seed.limits }])),
    selectedModels: new Map(MEMBER_SEEDS.map((seed) => [seed.member.id, [...seed.selectedModels]])),
    grants: baseGrants(),
    requests: BASE_REQUESTS.map((request) => ({
      ...request,
      context: { ...request.context, topModels: [...request.context.topModels] },
    })),
    decisions: BASE_DECISIONS.map((decision) => ({ ...decision })),
    rules: BASE_RULES.map((rule) => ({ ...rule, condition: { ...rule.condition } })),
    policy: {
      ...TEAM_POLICY,
      offHours: {
        ...TEAM_POLICY.offHours,
        workingDays: [...TEAM_POLICY.offHours.workingDays],
        holidays: [...TEAM_POLICY.offHours.holidays],
      },
      thresholds: { ...TEAM_POLICY.thresholds },
      notifications: TEAM_POLICY.notifications.map((entry) => ({
        ...entry,
        config: { ...entry.config },
      })),
    },
    audit: BASE_AUDIT.map((event) => ({ ...event })),
    notifications: BASE_NOTIFICATIONS.map((event) => ({ ...event })),
    key: new Map(
      MEMBER_SEEDS.map((seed) => [
        seed.member.id,
        {
          blocked: seed.member.blocked,
          reason: seed.member.blockedReason,
          lastRotatedAt: seed.member.blocked ? iso(NOW_MS - 5 * 3_600_000) : iso(NOW_MS - 20 * DAY),
        },
      ]),
    ),
    nextMember: 10,
    nextRequest: 10,
    nextId: 10,
  };
}

function activeGrant(grant: Grant, nowMs: number): boolean {
  if (grant.revokedAt !== null) return false;
  if (Date.parse(grant.startsAt) > nowMs) return false;
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= nowMs) return false;
  return true;
}

function effectivePolicy(state: FixtureState, member: Member, nowMs: number): EffectivePolicy {
  const limits = state.limits.get(member.id) ?? {
    budgetUsd: 0,
    period: "monthly",
    tokenCap: null,
    rpm: null,
    tpm: null,
  };
  const grants = state.grants.filter(
    (grant) => grant.memberId === member.id && activeGrant(grant, nowMs),
  );
  const selected = state.selectedModels.get(member.id) ?? [];
  const enabled = MODELS.filter((model) => model.state === "enabled").map((model) => model.id);
  const narrowed = selected.length === 0 ? enabled : enabled.filter((id) => selected.includes(id));
  const grantedModels = grants
    .filter((grant) => grant.scope === "model" && grant.modelId !== null)
    .map((grant) => grant.modelId ?? "")
    .filter((id) => MODELS.find((model) => model.id === id)?.state !== "blocked");
  const allowedModels = [...new Set([...narrowed, ...grantedModels])].sort();

  const budgetGrant = grants
    .filter((grant) => grant.scope === "budget")
    .reduce((sum, grant) => sum + (grant.amountUsd ?? 0), 0);
  const effectiveBudgetUsd = round2(limits.budgetUsd + budgetGrant);
  const tokenGrant = grants
    .filter((grant) => grant.scope === "token_cap")
    .reduce((sum, grant) => sum + (grant.tokenCap ?? 0), 0);
  const effectiveTokenCap =
    limits.tokenCap === null && grants.every((grant) => grant.scope !== "token_cap")
      ? null
      : (limits.tokenCap ?? 0) + tokenGrant;

  const spend = SPEND.get(member.id) ?? 0;
  const { softRatio, graceRatio } = state.policy.thresholds;
  const hardLimit = effectiveBudgetUsd * (1 + graceRatio);
  const keyBlocked = state.key.get(member.id)?.blocked === true;
  const reason = member.blockedReason ?? state.key.get(member.id)?.reason ?? null;
  let status: EffectivePolicy["status"] = "ok";
  if (member.blocked || keyBlocked || spend >= hardLimit) status = "blocked";
  else if (spend >= effectiveBudgetUsd) status = "grace";
  else if (spend >= effectiveBudgetUsd * softRatio) status = "soft";

  return {
    memberId: member.id,
    allowedModels,
    limits,
    grants,
    blocked: status === "blocked",
    blockedReason: status === "blocked" ? reason : null,
    effectiveBudgetUsd,
    effectiveTokenCap,
    status,
    computedAt: iso(nowMs),
  };
}

function memberById(state: FixtureState, id: string): Member {
  const found = state.members.find((candidate) => candidate.id === id);
  if (found === undefined) throw new ConsoleActionError("That member does not exist.", 404);
  return found;
}

function teamSpend(state: FixtureState): number {
  return round2(state.members.reduce((sum, member) => sum + (MONTH_SPEND.get(member.id) ?? 0), 0));
}

function contextFor(memberId: string, limitUsd: number): RequestContext {
  const spend = SPEND.get(memberId) ?? 0;
  const topModels = MODELS.map((model) => ({
    modelId: model.id,
    spendUsd: round2(
      USAGE.rows
        .filter(
          (row) =>
            row.memberId === memberId &&
            row.modelId === model.id &&
            Date.parse(row.at) >= NOW_MS - 7 * DAY,
        )
        .reduce((sum, row) => sum + row.costUsd, 0),
    ),
  }))
    .filter((row) => row.spendUsd > 0)
    .slice(0, 3);
  return {
    spendThisPeriodUsd: spend,
    limitUsd,
    topModels,
    last7DaysUsd: round2(
      USAGE.rows
        .filter((row) => row.memberId === memberId && Date.parse(row.at) >= NOW_MS - 7 * DAY)
        .reduce((sum, row) => sum + row.costUsd, 0),
    ),
  };
}

function nextPeriodEnd(period: Limits["period"], nowMs: number): string {
  if (period === "daily") {
    const next = new Date(nowMs);
    next.setUTCHours(24, 0, 0, 0);
    return iso(next.getTime());
  }
  if (period === "weekly") return iso(nowMs + 7 * DAY);
  const date = new Date(nowMs);
  return iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function pushAudit(
  state: FixtureState,
  input: {
    actorType: ActorType;
    actorId: string | null;
    actorName: string | null;
    action: string;
    objectType: string;
    objectId: string;
    before: unknown;
    after: unknown;
    reason: string | null;
  },
): void {
  state.nextId += 1;
  state.audit.unshift(
    auditEvent({
      id: `aud_${String(state.nextId).padStart(4, "0")}`,
      at: iso(NOW_MS),
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: input.actorName,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      before: input.before,
      after: input.after,
      reason: input.reason,
    }),
  );
}

export interface FixtureConsole {
  data: ConsoleData;
  actions: ConsoleActions;
  auth: ConsoleAuth;
  viewer: Viewer;
  now: Date;
  timeZone: string;
}

export function createFixtureConsole(): FixtureConsole {
  const state = createState();
  const priya = memberById(state, "mem_priya");

  const viewer: Viewer = {
    role: "manager",
    displayName: priya.displayName,
    teamId: TEAM.id,
    teamName: TEAM.name,
    memberId: priya.id,
    csrfToken: FIXTURE_CSRF,
    email: priya.email,
  };

  const data: ConsoleData = {
    async overview(sort: PageSort): Promise<OverviewData> {
      const rows = state.members.map((memberRow) => ({
        member: memberRow,
        policy: effectivePolicy(state, memberRow, NOW_MS),
        spendUsd: SPEND.get(memberRow.id) ?? 0,
        monthSpendUsd: MONTH_SPEND.get(memberRow.id) ?? 0,
      }));
      const rank: Record<string, number> = { ok: 0, soft: 1, grace: 2, blocked: 3 };
      const sorted = [...rows].sort((left, right) => {
        let value = 0;
        switch (sort.key) {
          case "name":
            value = left.member.displayName.localeCompare(right.member.displayName);
            break;
          case "spend":
            value = left.spendUsd - right.spendUsd;
            break;
          case "used":
            value =
              left.spendUsd / Math.max(0.01, left.policy.effectiveBudgetUsd) -
              right.spendUsd / Math.max(0.01, right.policy.effectiveBudgetUsd);
            break;
          case "status":
            value = (rank[left.policy.status] ?? 0) - (rank[right.policy.status] ?? 0);
            break;
        }
        return sort.direction === "asc" ? value : -value;
      });

      const spendByModel = MODELS.map((model) => {
        const rowsForModel = USAGE.rows.filter(
          (row) => row.modelId === model.id && Date.parse(row.at) >= NOW_MS - 30 * DAY,
        );
        return {
          modelId: model.id,
          modelName: model.displayName,
          spendUsd: round2(rowsForModel.reduce((sum, row) => sum + row.costUsd, 0)),
          requests: rowsForModel.length,
        };
      }).filter((row) => row.spendUsd > 0);

      return {
        team: TEAM,
        teamPolicy: state.policy,
        members: sorted,
        models: MODELS,
        openRequests: state.requests
          .filter((request) => request.state === "pending")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        alerts: state.notifications.slice(0, 4),
        spendByModel,
        teamSpendUsd: teamSpend(state),
        periodLabel: "This month",
        periodEndsAt: nextPeriodEnd("monthly", NOW_MS),
      };
    },

    async members(): Promise<Member[]> {
      return [...state.members].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    },

    async requests(filter: RequestListFilter): Promise<Request[]> {
      let rows = state.requests.filter((request) =>
        filter.view === "inbox" ? request.state === "pending" : request.state !== "pending",
      );
      if (filter.view === "history" && filter.state !== "all") {
        rows = rows.filter((request) => request.state === filter.state);
      }
      if (filter.memberId !== null) {
        rows = rows.filter((request) => request.memberId === filter.memberId);
      }
      if (filter.query !== "") {
        const query = filter.query.toLowerCase();
        rows = rows.filter((request) => {
          const memberName =
            state.members.find((candidate) => candidate.id === request.memberId)?.displayName ?? "";
          return (
            request.id.toLowerCase().includes(query) ||
            request.message.toLowerCase().includes(query) ||
            memberName.toLowerCase().includes(query)
          );
        });
      }
      return rows
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, filter.limit);
    },

    async requestCounts(): Promise<{ inbox: number; history: number }> {
      return {
        inbox: state.requests.filter((request) => request.state === "pending").length,
        history: state.requests.filter((request) => request.state !== "pending").length,
      };
    },

    async requestDetail(id: string): Promise<RequestDetail | null> {
      const request = state.requests.find((candidate) => candidate.id === id);
      if (request === undefined) return null;
      const memberRow = state.members.find((candidate) => candidate.id === request.memberId);
      if (memberRow === undefined) return null;
      const requested = MODELS.find((model) => model.id === request.modelId);
      const cheaper =
        request.kind === "model_unlock" && requested !== undefined
          ? MODELS.filter(
              (model) =>
                model.state === "enabled" && model.outputPer1MUsd < requested.outputPer1MUsd,
            ).sort((left, right) => left.outputPer1MUsd - right.outputPer1MUsd)[0]
          : undefined;
      const hint =
        cheaper === undefined || requested === undefined
          ? null
          : `${cheaper.displayName} is enabled at USD ${cheaper.outputPer1MUsd.toFixed(2)} per 1M output tokens, cheaper than ${requested.displayName} at USD ${requested.outputPer1MUsd.toFixed(2)}.`;
      return {
        request,
        member: memberRow,
        decisions: state.decisions.filter((decision) => decision.requestId === request.id),
        hint,
      };
    },

    async memberDetail(id: string): Promise<MemberDetail | null> {
      const memberRow = state.members.find((candidate) => candidate.id === id);
      if (memberRow === undefined) return null;
      const policy = effectivePolicy(state, memberRow, NOW_MS);
      const key = state.key.get(id) ?? { blocked: false, reason: null, lastRotatedAt: null };
      return {
        member: memberRow,
        team: TEAM,
        policy,
        limits: state.limits.get(id) ?? policy.limits,
        selectedModelIds: state.selectedModels.get(id) ?? [],
        spendUsd: SPEND.get(id) ?? 0,
        grants: policy.grants,
        usage: USAGE.rows
          .filter((row) => row.memberId === id && Date.parse(row.at) >= NOW_MS - 30 * DAY)
          .sort((left, right) => left.at.localeCompare(right.at)),
        audit: state.audit
          .filter((event) => event.objectId === id || event.actor.id === id)
          .sort((left, right) => right.at.localeCompare(left.at))
          .slice(0, 8),
        keyState: {
          active: key.blocked !== true && policy.status !== "blocked",
          blocked: key.blocked === true,
          status: policy.status,
          reason: key.reason,
          lastRotatedAt: key.lastRotatedAt,
        },
      };
    },

    async models(): Promise<ModelsData> {
      const rows: ModelRow[] = MODELS.map((model) => ({
        model,
        requestsLast30Days: state.requests.filter(
          (request) =>
            request.modelId === model.id && Date.parse(request.createdAt) >= NOW_MS - 30 * DAY,
        ).length,
        membersAllowed: state.members.filter((memberRow) =>
          effectivePolicy(state, memberRow, NOW_MS).allowedModels.includes(model.id),
        ).length,
      }));
      return { models: rows };
    },

    async rules(): Promise<{ rules: Rule[]; policy: TeamPolicy }> {
      return { rules: [...state.rules], policy: state.policy };
    },

    async audit(filter: {
      actorId: string | null;
      objectType: string | null;
      objectId: string | null;
      from: string | null;
      to: string | null;
      limit: number;
      offset: number;
    }): Promise<AuditEvent[]> {
      let events = [...state.audit];
      if (filter.actorId !== null)
        events = events.filter((event) => event.actor.id === filter.actorId);
      if (filter.objectType !== null && filter.objectType !== "") {
        const needle = filter.objectType.toLowerCase();
        events = events.filter((event) => event.objectType.toLowerCase().includes(needle));
      }
      if (filter.objectId !== null && filter.objectId !== "") {
        events = events.filter((event) => event.objectId === filter.objectId);
      }
      if (filter.from !== null && filter.from !== "") {
        const from = Date.parse(`${filter.from}T00:00:00Z`);
        events = events.filter((event) => Date.parse(event.at) >= from);
      }
      if (filter.to !== null && filter.to !== "") {
        const to = Date.parse(`${filter.to}T23:59:59Z`);
        events = events.filter((event) => Date.parse(event.at) <= to);
      }
      return events
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(filter.offset, filter.offset + filter.limit);
    },

    async auditActors(): Promise<Array<{ id: string; name: string }>> {
      const actors = new Map<string, string>();
      for (const event of state.audit) {
        if (event.actor.id !== null) {
          actors.set(event.actor.id, event.actor.displayName ?? event.actor.type);
        }
      }
      return [...actors.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async setup(): Promise<SetupData> {
      const members: SetupMemberRow[] = state.members.map((memberRow) => ({
        member: memberRow,
        policy: effectivePolicy(state, memberRow, NOW_MS),
        spendUsd: SPEND.get(memberRow.id) ?? 0,
        reports:
          MEMBER_SEEDS.find((seed) => seed.member.id === memberRow.id)?.doctor.map(
            (report, index) => ({
              id: `doctor_${memberRow.id}_${index}`,
              memberId: memberRow.id,
              cli: report.cli,
              version: report.version,
              gatewayOk: report.gatewayOk,
              mcpOk: report.mcpOk,
              managedConfig: report.managedConfig,
              at: iso(NOW_MS - (index + 1) * 3_600_000),
              notes: report.notes,
            }),
          ) ?? [],
      }));
      return {
        team: TEAM,
        members,
        gatewayHealthy: true,
        gatewayCheckedAt: FIXTURE_NOW,
        packVersion: "v1 · 2026-10-30",
        packFiles: [
          "/etc/claude-code/managed-settings.json",
          "/etc/opencode/opencode.json",
          "/etc/codex/requirements.toml",
          "/etc/codex/managed_config.toml",
          "install.sh",
          "team.mobileconfig",
        ],
      };
    },

    async me(viewerArg: Viewer): Promise<MyData | null> {
      if (viewerArg.memberId === null) return null;
      const memberRow = state.members.find((candidate) => candidate.id === viewerArg.memberId);
      if (memberRow === undefined) return null;
      const policy = effectivePolicy(state, memberRow, NOW_MS);
      return {
        member: memberRow,
        team: TEAM,
        policy,
        spendUsd: SPEND.get(memberRow.id) ?? 0,
        requests: state.requests
          .filter(
            (request) =>
              request.memberId === memberRow.id &&
              Date.parse(request.createdAt) >= NOW_MS - 30 * DAY,
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        usage: USAGE.rows
          .filter((row) => row.memberId === memberRow.id && Date.parse(row.at) >= NOW_MS - 30 * DAY)
          .sort((left, right) => left.at.localeCompare(right.at)),
        allowedModels: MODELS.filter((model) => policy.allowedModels.includes(model.id)),
        resetAt: nextPeriodEnd(policy.limits.period, NOW_MS),
      };
    },

    async openRequestCount(): Promise<number> {
      return state.requests.filter((request) => request.state === "pending").length;
    },

    async usage(query) {
      const members = state.members.map((memberRow) => {
        const policy = effectivePolicy(state, memberRow, NOW_MS);
        return {
          id: memberRow.id,
          displayName: memberRow.displayName,
          status: policy.status,
          limitUsd: policy.effectiveBudgetUsd,
        };
      });
      return buildUsageReport({
        query,
        now: new Date(FIXTURE_NOW),
        timeZone: FIXTURE_TIME_ZONE,
        scopeLabel: `${TEAM.name} team`,
        members,
        models: MODELS,
        usage: USAGE.rows,
      });
    },

    async bundle(memberId: string): Promise<BundleFile | null> {
      const memberRow = state.members.find((candidate) => candidate.id === memberId);
      if (memberRow === undefined) return null;
      const limits = state.limits.get(memberId);
      const body = [
        `# team-ai-allowance config bundle for ${memberRow.displayName}`,
        "# Fixture bundle. The setup pack generator writes the real files.",
        "",
        "[env]",
        "TAA_BASE_URL=http://127.0.0.1:18080",
        "TAA_MEMBER_KEY=__paste_the_key_shown_at_enrolment__",
        "",
        "[member]",
        `id=${memberRow.id}`,
        `key_alias=${memberRow.keyAlias}`,
        `budget_usd=${(limits?.budgetUsd ?? 0).toFixed(2)}`,
        `period=${limits?.period ?? "monthly"}`,
        "",
        "[mcp]",
        "command=taa mcp --role member --key-file ./member.key",
        "",
      ].join("\n");
      return {
        filename: `taa-${memberRow.id}.env`,
        contentType: "text/plain; charset=utf-8",
        body,
      };
    },

    async modelCatalogue(): Promise<ModelEntry[]> {
      return [...MODELS];
    },
  };

  const actions: ConsoleActions = {
    async decide(requestId: string, input: DecideInput): Promise<ActionReceipt> {
      const request = state.requests.find((candidate) => candidate.id === requestId);
      if (request === undefined) throw new ConsoleActionError("That request does not exist.", 404);
      if (request.state !== "pending") {
        throw new ConsoleActionError("That request was already decided.", 409);
      }
      const memberRow = memberById(state, request.memberId);
      const limits = state.limits.get(memberRow.id) ?? {
        budgetUsd: 0,
        period: "monthly",
        tokenCap: null,
        rpm: null,
        tpm: null,
      };
      const isBudget = request.kind === "more_budget";
      const isModel = request.kind === "model_unlock";

      if (input.outcome === "partly_approved" || input.outcome === "approved") {
        if (input.outcome === "partly_approved" && isBudget) {
          if (
            input.amountUsd === null ||
            !Number.isFinite(input.amountUsd) ||
            input.amountUsd <= 0
          ) {
            throw new ConsoleActionError("Enter an amount above zero to partly approve.", 400);
          }
          if (request.amountUsd !== null && input.amountUsd > request.amountUsd) {
            throw new ConsoleActionError(
              `The requested amount is ${request.amountUsd.toFixed(2)}; approve that in full instead.`,
              422,
            );
          }
        }
        if (input.outcome === "approved" && isBudget && (request.amountUsd ?? 0) <= 0) {
          throw new ConsoleActionError("This request has no amount to approve.", 400);
        }
      }

      const grantedAmountUsd =
        isBudget && input.outcome !== "denied"
          ? input.outcome === "partly_approved"
            ? round2(input.amountUsd ?? 0)
            : round2(request.amountUsd ?? input.amountUsd ?? 0)
          : null;
      const grantedModelId = isModel && input.outcome !== "denied" ? request.modelId : null;

      const untilMs = input.permanent
        ? null
        : input.until !== null && input.until !== ""
          ? Date.parse(`${input.until}T23:59:59Z`)
          : Date.parse(nextPeriodEnd(limits.period, NOW_MS));
      if (untilMs !== null && Number.isNaN(untilMs)) {
        throw new ConsoleActionError("That end date is not valid.", 400);
      }

      state.nextId += 1;
      const grantId = `grant_${String(state.nextId).padStart(4, "0")}`;
      const expiry = untilMs === null ? null : iso(untilMs);
      if (grantedAmountUsd !== null && grantedAmountUsd > 0) {
        state.grants.push({
          id: grantId,
          memberId: memberRow.id,
          scope: "budget",
          amountUsd: grantedAmountUsd,
          modelId: null,
          tokenCap: null,
          requestId: request.id,
          issuedBy: "manager",
          issuedById: "mem_priya",
          startsAt: iso(NOW_MS),
          expiresAt: expiry,
          revokedAt: null,
          createdAt: iso(NOW_MS),
        });
      }
      if (grantedModelId !== null) {
        state.grants.push({
          id: grantId,
          memberId: memberRow.id,
          scope: "model",
          amountUsd: null,
          modelId: grantedModelId,
          tokenCap: null,
          requestId: request.id,
          issuedBy: "manager",
          issuedById: "mem_priya",
          startsAt: iso(NOW_MS),
          expiresAt: expiry,
          revokedAt: null,
          createdAt: iso(NOW_MS),
        });
      }

      state.nextId += 1;
      const decision: Decision = {
        id: `dec_${String(state.nextId).padStart(4, "0")}`,
        requestId: request.id,
        outcome: input.outcome,
        decidedById: "mem_priya",
        decidedByRole: "manager",
        note: input.note !== null && input.note.trim() !== "" ? input.note.trim() : null,
        grantedAmountUsd,
        grantedModelId,
        grantExpiresAt: expiry,
        grantId: grantedAmountUsd !== null || grantedModelId !== null ? grantId : null,
        source: "manager",
        decidedAt: iso(NOW_MS),
      };
      state.decisions.push(decision);
      request.state = input.outcome;
      request.decidedAt = iso(NOW_MS);

      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: `request.${input.outcome}`,
        objectType: "request",
        objectId: request.id,
        before: { state: "pending" },
        after: {
          state: request.state,
          outcome: input.outcome,
          grantedAmountUsd,
          grantedModelId,
          grantExpiresAt: expiry,
        },
        reason: decision.note,
      });

      state.notifications.unshift({
        id: `not_${state.nextId}`,
        at: iso(NOW_MS),
        kind: "request_decided",
        audience: "member",
        teamId: TEAM.id,
        memberId: memberRow.id,
        title:
          input.outcome === "denied"
            ? "Your request was denied."
            : input.outcome === "partly_approved"
              ? "Your request was partly approved."
              : "Your request was approved.",
        body: decision.note ?? "Open My allowance to see the details.",
        link: `/requests/${request.id}`,
        dedupeKey: `decision:${request.id}`,
      });

      const message =
        input.outcome === "denied"
          ? "Request denied."
          : input.outcome === "partly_approved"
            ? `Request partly approved${grantedAmountUsd === null ? "" : ` for USD ${grantedAmountUsd.toFixed(2)}`}${expiry === null ? ", permanent" : `, until ${expiry.slice(0, 10)}`}.`
            : `Request approved${grantedAmountUsd === null ? "" : ` for USD ${grantedAmountUsd.toFixed(2)}`}${grantedModelId === null ? "" : ` for ${grantedModelId}`}${expiry === null ? ", permanent" : `, until ${expiry.slice(0, 10)}`}.`;
      return { message, secret: null, memberId: memberRow.id };
    },

    async updateLimits(memberId: string, input: LimitsInput): Promise<ActionReceipt> {
      memberById(state, memberId);
      if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0) {
        throw new ConsoleActionError("The budget must be zero or more.", 400);
      }
      if (input.tokenCap !== null && (!Number.isFinite(input.tokenCap) || input.tokenCap <= 0)) {
        throw new ConsoleActionError("The token cap must be a positive whole number.", 400);
      }
      if (input.rpm !== null && input.rpm <= 0)
        throw new ConsoleActionError("Requests per minute must be positive.", 400);
      if (input.tpm !== null && input.tpm <= 0)
        throw new ConsoleActionError("Tokens per minute must be positive.", 400);
      const before = state.limits.get(memberId) ?? null;
      const limits: Limits = {
        budgetUsd: round2(input.budgetUsd),
        period: input.period,
        tokenCap: input.tokenCap,
        rpm: input.rpm,
        tpm: input.tpm,
      };
      state.limits.set(memberId, limits);
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "member.limits.updated",
        objectType: "member",
        objectId: memberId,
        before,
        after: limits,
        reason: null,
      });
      return {
        message: "Limits saved. The key updates on the next reconcile.",
        secret: null,
        memberId,
      };
    },

    async updateModels(memberId: string, modelIds: string[]): Promise<ActionReceipt> {
      memberById(state, memberId);
      const enabled = new Set(
        MODELS.filter((model) => model.state === "enabled").map((model) => model.id),
      );
      for (const id of modelIds) {
        if (!enabled.has(id)) throw new ConsoleActionError(`${id} is not an enabled model.`, 422);
      }
      const before = state.selectedModels.get(memberId) ?? [];
      state.selectedModels.set(memberId, [...new Set(modelIds)]);
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "member.models.updated",
        objectType: "member",
        objectId: memberId,
        before,
        after: modelIds,
        reason: null,
      });
      return { message: "Allowed models saved.", secret: null, memberId };
    },

    async keyAction(
      memberId: string,
      action: "block" | "unblock" | "rotate",
      reason: string | null,
    ): Promise<ActionReceipt> {
      const memberRow = memberById(state, memberId);
      const key = state.key.get(memberId) ?? { blocked: false, reason: null, lastRotatedAt: null };
      if (action === "block") {
        state.key.set(memberId, {
          ...key,
          blocked: true,
          reason: reason ?? "Blocked by a manager.",
        });
        memberRow.blocked = true;
        memberRow.blockedReason = reason ?? "Blocked by a manager.";
        pushAudit(state, {
          actorType: "manager",
          actorId: "mem_priya",
          actorName: "Priya",
          action: "key.blocked",
          objectType: "member",
          objectId: memberId,
          before: { blocked: false },
          after: { blocked: true, reason: reason ?? "Blocked by a manager." },
          reason,
        });
        return {
          message: "Key blocked. A call is refused at the gateway.",
          secret: null,
          memberId,
        };
      }
      if (action === "unblock") {
        state.key.set(memberId, { ...key, blocked: false, reason: null });
        memberRow.blocked = false;
        memberRow.blockedReason = null;
        pushAudit(state, {
          actorType: "manager",
          actorId: "mem_priya",
          actorName: "Priya",
          action: "key.unblocked",
          objectType: "member",
          objectId: memberId,
          before: { blocked: true },
          after: { blocked: false },
          reason: null,
        });
        return {
          message: "Key unblocked. The next call is allowed within the limits.",
          secret: null,
          memberId,
        };
      }
      state.nextId += 1;
      const secret = `taa_key_fixture_${String(state.nextId).padStart(6, "0")}`;
      state.key.set(memberId, { ...key, lastRotatedAt: iso(NOW_MS), blocked: false, reason: null });
      memberRow.keyHash = createHash("sha256").update(secret).digest("hex");
      memberRow.blocked = false;
      memberRow.blockedReason = null;
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "key.rotated",
        objectType: "member",
        objectId: memberId,
        before: { keyAlias: memberRow.keyAlias },
        after: { keyAlias: memberRow.keyAlias, rotatedAt: iso(NOW_MS) },
        reason: null,
      });
      return { message: "Key rotated. Copy the new key now; it is shown once.", secret, memberId };
    },

    async saveRule(rule: Rule): Promise<ActionReceipt> {
      if (rule.name.trim() === "") throw new ConsoleActionError("Give the rule a name.", 400);
      if (rule.condition.kind === "budget_topup") {
        if (rule.condition.maxUsd <= 0)
          throw new ConsoleActionError("The maximum top-up must be above zero.", 400);
        if (!Number.isInteger(rule.condition.oncePerDays) || rule.condition.oncePerDays < 1) {
          throw new ConsoleActionError("The limit must be at least once per day.", 400);
        }
      } else {
        if (rule.condition.modelIds.length === 0)
          throw new ConsoleActionError("Choose at least one model.", 400);
        if (rule.condition.durationHours < 1)
          throw new ConsoleActionError("The unlock must last at least an hour.", 400);
      }
      const existing = state.rules.find((candidate) => candidate.id === rule.id);
      if (existing === undefined) {
        state.nextId += 1;
        const created: Rule = { ...rule, id: `rule_${String(state.nextId).padStart(4, "0")}` };
        state.rules.push(created);
        pushAudit(state, {
          actorType: "manager",
          actorId: "mem_priya",
          actorName: "Priya",
          action: "rule.created",
          objectType: "rule",
          objectId: created.id,
          before: null,
          after: created,
          reason: null,
        });
        return { message: "Rule created.", secret: null, memberId: null };
      }
      const before = { ...existing, condition: { ...existing.condition } };
      existing.name = rule.name;
      existing.enabled = rule.enabled;
      existing.condition = rule.condition;
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "rule.updated",
        objectType: "rule",
        objectId: existing.id,
        before,
        after: existing,
        reason: null,
      });
      return { message: "Rule saved.", secret: null, memberId: null };
    },

    async savePolicy(policy: TeamPolicy): Promise<ActionReceipt> {
      if (policy.thresholds.softRatio <= 0 || policy.thresholds.softRatio > 1) {
        throw new ConsoleActionError("The soft limit must be between 1% and 100%.", 400);
      }
      if (policy.thresholds.graceRatio < 0 || policy.thresholds.graceRatio > 1) {
        throw new ConsoleActionError("Grace must be between 0% and 100%.", 400);
      }
      if (policy.offHours.enabled && policy.offHours.endMinute <= policy.offHours.startMinute) {
        throw new ConsoleActionError("The working hours end must be after the start.", 400);
      }
      if (policy.offHours.workingDays.length === 0) {
        throw new ConsoleActionError("Choose at least one working day.", 400);
      }
      const before = state.policy;
      state.policy = { ...policy, updatedAt: iso(NOW_MS) };
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "team.policy.updated",
        objectType: "team",
        objectId: TEAM.id,
        before,
        after: state.policy,
        reason: null,
      });
      return { message: "Team policy saved.", secret: null, memberId: null };
    },

    async createRequest(input: {
      kind: RequestKind;
      amountUsd: number | null;
      modelId: string | null;
      message: string;
    }): Promise<ActionReceipt> {
      const message = input.message.trim();
      if (message === "") throw new ConsoleActionError("Say why you need it.", 400);
      if (message.length > 600)
        throw new ConsoleActionError("Keep the reason under 600 characters.", 400);
      if (input.kind === "more_budget" && (input.amountUsd === null || input.amountUsd <= 0)) {
        throw new ConsoleActionError("Enter an amount above zero.", 400);
      }
      if (input.kind === "model_unlock") {
        if (input.modelId === null || input.modelId === "") {
          throw new ConsoleActionError("Choose a model.", 400);
        }
        const model = MODELS.find((candidate) => candidate.id === input.modelId);
        if (model === undefined)
          throw new ConsoleActionError("That model is not in the catalogue.", 404);
        if (model.state === "blocked")
          throw new ConsoleActionError("That model is blocked for this team.", 422);
      }
      const memberRow = memberById(state, "mem_priya");
      state.nextRequest += 1;
      const id = `req_${String(state.nextRequest).padStart(4, "0")}`;
      const limits = state.limits.get(memberRow.id);
      const request: Request = {
        id,
        memberId: memberRow.id,
        teamId: TEAM.id,
        kind: input.kind,
        amountUsd: input.kind === "more_budget" ? round2(input.amountUsd ?? 0) : null,
        modelId: input.kind === "model_unlock" ? input.modelId : null,
        message,
        state: "pending",
        context: contextFor(memberRow.id, limits?.budgetUsd ?? 0),
        createdAt: iso(NOW_MS),
        expiresAt: iso(NOW_MS + 72 * 3_600_000),
        decidedAt: null,
      };
      state.requests.push(request);
      state.notifications.unshift({
        id: `not_${id}`,
        at: iso(NOW_MS),
        kind: "request_created",
        audience: "manager",
        teamId: TEAM.id,
        memberId: memberRow.id,
        title: `${memberRow.displayName} sent a request.`,
        body: message,
        link: `/requests/${id}`,
        dedupeKey: `request:${id}`,
      });
      pushAudit(state, {
        actorType: "member",
        actorId: memberRow.id,
        actorName: memberRow.displayName,
        action: "request.created",
        objectType: "request",
        objectId: id,
        before: null,
        after: { kind: input.kind, amountUsd: request.amountUsd, modelId: request.modelId },
        reason: message,
      });
      return { message: "Request sent to your manager.", secret: null, memberId: memberRow.id };
    },

    async cancelRequest(requestId: string): Promise<ActionReceipt> {
      const request = state.requests.find((candidate) => candidate.id === requestId);
      if (request === undefined) throw new ConsoleActionError("That request does not exist.", 404);
      if (request.state !== "pending")
        throw new ConsoleActionError("Only a pending request can be cancelled.", 409);
      const before = request.state;
      request.state = "cancelled";
      request.decidedAt = iso(NOW_MS);
      pushAudit(state, {
        actorType: "member",
        actorId: request.memberId,
        actorName:
          state.members.find((candidate) => candidate.id === request.memberId)?.displayName ?? null,
        action: "request.cancelled",
        objectType: "request",
        objectId: request.id,
        before: { state: before },
        after: { state: "cancelled" },
        reason: null,
      });
      return { message: "Request cancelled.", secret: null, memberId: request.memberId };
    },

    async revokeGrant(memberId: string, grantId: string, reason: string): Promise<ActionReceipt> {
      const grant = state.grants.find((candidate) => candidate.id === grantId);
      if (grant === undefined || grant.memberId !== memberId) {
        throw new ConsoleActionError("That grant does not exist.", 404);
      }
      if (grant.revokedAt !== null) {
        throw new ConsoleActionError("That grant is already revoked.", 409);
      }
      grant.revokedAt = iso(NOW_MS);
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "grant.revoked",
        objectType: "grant",
        objectId: grant.id,
        before: { revokedAt: null },
        after: { revokedAt: grant.revokedAt },
        reason,
      });
      return {
        message: "Grant revoked. The key updates on the next reconcile.",
        secret: null,
        memberId,
      };
    },

    async enrolMember(input: EnrolInput): Promise<ActionReceipt> {
      const displayName = input.displayName.trim();
      if (displayName.length < 2) throw new ConsoleActionError("Enter a display name.", 400);
      if (input.email !== null && input.email !== "" && !input.email.includes("@")) {
        throw new ConsoleActionError("That e-mail address does not look right.", 400);
      }
      if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) {
        throw new ConsoleActionError("Enter a budget above zero.", 400);
      }
      state.nextMember += 1;
      const id = `mem_${String(state.nextMember).padStart(4, "0")}`;
      state.nextId += 1;
      const secret = `taa_key_fixture_${String(state.nextId).padStart(6, "0")}`;
      const created: Member = {
        id,
        teamId: TEAM.id,
        displayName,
        email: input.email === "" ? null : input.email,
        role: input.role,
        keyAlias: `taa-${id}`,
        keyHash: createHash("sha256").update(secret).digest("hex"),
        blocked: false,
        blockedReason: null,
        createdAt: iso(NOW_MS),
        updatedAt: iso(NOW_MS),
      };
      state.members.push(created);
      state.limits.set(id, {
        budgetUsd: round2(input.budgetUsd),
        period: input.period,
        tokenCap: null,
        rpm: 60,
        tpm: 200_000,
      });
      state.selectedModels.set(id, []);
      state.key.set(id, { blocked: false, reason: null, lastRotatedAt: iso(NOW_MS) });
      pushAudit(state, {
        actorType: "manager",
        actorId: "mem_priya",
        actorName: "Priya",
        action: "member.enrolled",
        objectType: "member",
        objectId: id,
        before: null,
        after: { displayName, role: input.role, budgetUsd: input.budgetUsd, period: input.period },
        reason: null,
      });
      return {
        message: `${displayName} is enrolled. Copy the key now; it is shown once.`,
        secret,
        memberId: id,
      };
    },
  };

  const auth: ConsoleAuth = {
    async login(attempt): Promise<LoginResult> {
      const email = attempt.email;
      const password = attempt.password;
      const account = state.members.find(
        (candidate) =>
          candidate.email !== null && candidate.email.toLowerCase() === email.trim().toLowerCase(),
      );
      if (account === undefined || account.role === "member") {
        return {
          ok: false,
          message: "That account cannot sign in to the console.",
          cookie: null,
          viewer: null,
        };
      }
      if (password.trim() === "") {
        return { ok: false, message: "Enter your password.", cookie: null, viewer: null };
      }
      return {
        ok: true,
        message: null,
        cookie: "taa_session=fixture-session; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200",
        viewer,
      };
    },
    logout(): string {
      return "taa_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
    },
  };

  return {
    data,
    actions,
    auth,
    viewer,
    now: new Date(FIXTURE_NOW),
    timeZone: FIXTURE_TIME_ZONE,
  };
}
