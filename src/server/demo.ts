/**
 * The demo organisation: one team, a manager, three members, three models.
 *
 * The same seed serves `taa serve --demo` (a first start with no data) and
 * `scripts/demo.ts` (write the database, print where the console is). It is
 * idempotent: when the team already exists the seed does nothing and says so.
 *
 * Members get readable ids (`mem_lena`) so a screenshot, a curl command and an
 * audit line all name the same person. Real enrolments use random ids.
 *
 * Allowance numbers are small on purpose. A model call through the mock
 * upstream costs a fraction of a cent, and the demo's gateway mock charges a
 * fixed amount per call, so a few dollars is a whole working week.
 */

import type { CredentialStore, ManagerTokenStore } from "../auth/index.ts";
import { hashPassword, issueManagerToken } from "../auth/index.ts";
import type {
  Clock,
  Grant,
  Member,
  ModelEntry,
  Request,
  Role,
  Team,
  TeamPolicy,
  UsageRow,
} from "../contracts.ts";
import {
  AUDIT_ACTIONS,
  AuditTrail,
  type ControlService,
  type CoreStore,
  type IdSource,
  keyAliasForMemberId,
  makeActor,
  periodStart,
  toIso,
} from "../core/index.ts";
import type { BootstrapSettings } from "./config.ts";
import type { ControlPortWithKeys } from "./control.ts";

export const DEMO_TEAM_ID = "team_platform";
export const DEMO_TEAM_NAME = "Platform";
export const DEMO_MANAGER_ID = "mem_priya";
export const DEMO_MODEL_IDS = ["mock-cheap", "mock-flash", "mock-flagship"] as const;
export const DEMO_ADMIN_ID = "mem_admin";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 21;

export interface DemoSeedOptions {
  store: CoreStore;
  control: ControlPortWithKeys;
  service: ControlService;
  credentials: CredentialStore;
  managerTokens: ManagerTokenStore;
  clock: Clock;
  ids: IdSource;
  demo: boolean;
  /** Clear text for the demo manager login; hashed before it is stored. */
  managerPassword: string | null;
  bootstrap: BootstrapSettings | null;
  logger?: (line: string) => void;
}

export interface DemoMemberKey {
  memberId: string;
  displayName: string;
  /** The member's gateway key. Shown once; never stored or logged. */
  secret: string;
}

export interface DemoSeedResult {
  created: boolean;
  teamId: string;
  members: Array<{ id: string; displayName: string; role: Role }>;
  /** Keys issued during this seed, for the caller that shows them once. */
  keys: DemoMemberKey[];
  /** The demo manager token, when the seed issued one. Shown once. */
  managerToken: string | null;
  reason: string;
}

function model(
  id: string,
  displayName: string,
  inputPer1MUsd: number,
  outputPer1MUsd: number,
  state: ModelEntry["state"],
  sortOrder: number,
): ModelEntry {
  return {
    id,
    displayName,
    route: `openai/${id}`,
    inputPer1MUsd,
    outputPer1MUsd,
    state,
    sortOrder,
  };
}

export function demoModels(): ModelEntry[] {
  return [
    model("mock-cheap", "Mock cheap", 1, 2, "enabled", 1),
    model("mock-flash", "Mock flash", 2, 4, "enabled", 2),
    model("mock-flagship", "Mock flagship", 5, 10, "approval-required", 3),
  ];
}

interface MemberSeed {
  displayName: string;
  role: Role;
  email: string | null;
  budgetUsd: number;
  period: "weekly" | "monthly";
  models: string[] | null;
}

const MEMBER_SEEDS: readonly MemberSeed[] = [
  {
    displayName: "Priya",
    role: "manager",
    email: "priya@example.test",
    budgetUsd: 2,
    period: "monthly",
    models: null,
  },
  {
    displayName: "Lena",
    role: "member",
    email: "lena@example.test",
    budgetUsd: 2,
    period: "weekly",
    models: ["mock-cheap"],
  },
  {
    displayName: "Omar",
    role: "member",
    email: "omar@example.test",
    budgetUsd: 5,
    period: "monthly",
    models: ["mock-cheap", "mock-flash"],
  },
  {
    displayName: "Jonas",
    role: "member",
    email: "jonas@example.test",
    budgetUsd: 10,
    period: "weekly",
    models: ["mock-cheap"],
  },
];

export async function seedDemo(options: DemoSeedOptions): Promise<DemoSeedResult> {
  const { store, control, service, credentials, managerTokens, clock, ids } = options;
  const logger = options.logger ?? (() => {});
  const now = clock.now();

  const existing = (await store.listTeams()).find((team) => team.name === DEMO_TEAM_NAME) ?? null;
  if (existing !== null) {
    const members = await store.listMembers(existing.id);
    if (options.bootstrap !== null) await ensureBootstrapAdmin(options, existing, now);
    return {
      created: false,
      teamId: existing.id,
      members: members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        role: member.role,
      })),
      keys: [],
      managerToken: null,
      reason: "the demo team already exists; nothing was written",
    };
  }

  const team = await store.createTeam({
    name: DEMO_TEAM_NAME,
    monthlyBudgetUsd: 120,
  });
  const trail = new AuditTrail(store, ids, clock);

  for (const entry of demoModels()) await store.upsertModel(entry);
  await store.setTeamPolicy(demoPolicy(team.id, now));

  const created: Member[] = [];
  const byName = new Map<string, Member>();
  for (const seed of MEMBER_SEEDS) {
    const inserted = await store.createMember({
      teamId: team.id,
      displayName: seed.displayName,
      email: seed.email,
      role: seed.role,
      keyAlias: `taa-pending-${seed.displayName.toLowerCase()}`,
      keyHash: null,
      blocked: false,
      blockedReason: null,
    });
    const member = await store.updateMember(inserted.id, {
      keyAlias: keyAliasForMemberId(inserted.id),
    });
    created.push(member);
    byName.set(member.displayName, member);
    await trail.record({
      actor: makeActor("admin", DEMO_ADMIN_ID, "Demo admin"),
      action: "member.created",
      objectType: "member",
      objectId: member.id,
      before: null,
      after: { id: member.id, displayName: member.displayName, role: member.role },
      reason: "demo seed",
      at: now,
    });
  }

  for (const seed of MEMBER_SEEDS) {
    const member = byName.get(seed.displayName);
    if (member === undefined) continue;
    await store.setLimits(member.id, {
      budgetUsd: seed.budgetUsd,
      period: seed.period,
      tokenCap: null,
      rpm: null,
      tpm: null,
    });
    if (seed.models !== null) await store.setMemberModels(member.id, seed.models, toIso(now));
  }

  await store.upsertRule({
    id: "rule_small_topup",
    teamId: team.id,
    name: "Small top-up once a week",
    enabled: true,
    condition: { kind: "budget_topup", maxUsd: 0.5, oncePerDays: 7 },
    createdAt: toIso(new Date(now.getTime() - HISTORY_DAYS * DAY_MS)),
  });

  await seedHistory(options, team, byName, now);

  const keys: DemoMemberKey[] = [];
  for (const member of created) {
    if (member.role !== "member") continue;
    try {
      const secret = await control.issueKey(member.id);
      keys.push({ memberId: member.id, displayName: member.displayName, secret });
    } catch (error) {
      logger(
        `seed: no gateway key for ${member.displayName} (${error instanceof Error ? error.name : "Error"})`,
      );
    }
  }
  await service.reconcile();

  let managerToken: string | null = null;
  if (options.demo) {
    const password = options.managerPassword?.trim() ?? "";
    if (password.length >= 12) {
      const manager = byName.get("Priya");
      if (manager === undefined) throw new Error("demo seed: no manager");
      await credentials.setPassword(manager.id, "priya@example.test", await hashPassword(password));
      const issued = await issueManagerToken(
        managerTokens,
        { memberId: manager.id, teamId: team.id, role: "manager", label: "demo manager" },
        clock,
      );
      managerToken = issued.token;
    } else {
      logger("seed: TAA_DEMO_MANAGER_PASSWORD is unset or too short; the console login is off");
    }
  }

  if (options.bootstrap !== null) await ensureBootstrapAdmin(options, team, now);

  return {
    created: true,
    teamId: team.id,
    members: created.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      role: member.role,
    })),
    keys,
    managerToken,
    reason: "seeded the demo team",
  };
}

/**
 * The bootstrap admin account, kept stable across restarts.
 *
 * The password and the manager tokens live in an in-memory credential store,
 * so after a restart `findByEmail` no longer finds the admin and
 * `getMember(DEMO_ADMIN_ID)` misses the row the first start created (its id is
 * generated). Look the row up by alias and by e-mail before inserting, so a
 * second boot re-uses the existing admin instead of failing on the UNIQUE
 * `members.key_alias` constraint.
 */
async function ensureBootstrapAdmin(
  options: DemoSeedOptions,
  team: Team,
  now: Date,
): Promise<void> {
  const bootstrap = options.bootstrap;
  if (bootstrap === null) return;
  if ((await options.credentials.findByEmail(bootstrap.email)) !== null) return;
  const adminAlias = keyAliasForMemberId(DEMO_ADMIN_ID);
  let member = (await options.store.getMember(DEMO_ADMIN_ID)) ?? null;
  if (member === null) {
    for (const candidateTeam of await options.store.listTeams()) {
      const found = (await options.store.listMembers(candidateTeam.id)).find(
        (candidate) => candidate.keyAlias === adminAlias || candidate.email === bootstrap.email,
      );
      if (found !== undefined) {
        member = found;
        break;
      }
    }
  }
  let created = false;
  if (member === null) {
    member = await options.store.createMember({
      teamId: team.id,
      displayName: bootstrap.displayName,
      email: bootstrap.email,
      role: "admin",
      keyAlias: adminAlias,
      keyHash: null,
      blocked: false,
      blockedReason: null,
    });
    created = true;
    await options.store.setLimits(member.id, {
      budgetUsd: 0,
      period: "monthly",
      tokenCap: null,
      rpm: null,
      tpm: null,
    });
  }
  await options.credentials.setPassword(
    member.id,
    bootstrap.email,
    await hashPassword(bootstrap.password),
    toIso(now),
  );
  if (!created) return;
  const trail = new AuditTrail(options.store, options.ids, options.clock);
  await trail.record({
    actor: makeActor("system", "bootstrap", "Bootstrap"),
    action: "admin.created",
    objectType: "member",
    objectId: member.id,
    before: null,
    after: { id: member.id, role: "admin" },
    reason: "first start",
    at: now,
  });
}

async function seedHistory(
  options: DemoSeedOptions,
  team: Team,
  members: Map<string, Member>,
  now: Date,
): Promise<void> {
  const { store, ids } = options;
  const lena = members.get("Lena");
  const omar = members.get("Omar");
  const jonas = members.get("Jonas");
  if (lena === undefined || omar === undefined || jonas === undefined) return;
  const rows: UsageRow[] = [];
  const push = (
    memberId: string,
    modelId: string,
    costUsd: number,
    daysAgo: number,
    index: number,
  ) => {
    rows.push({
      id: ids.next("use"),
      memberId,
      modelId,
      at: toIso(new Date(now.getTime() - daysAgo * DAY_MS + index * 60_000)),
      inputTokens: 18_000 + index * 1_200,
      outputTokens: 900 + index * 60,
      costUsd,
      requestId: `seed_${memberId}_${daysAgo}_${index}`,
      apiFormat:
        memberId === omar.id
          ? "responses"
          : memberId === jonas.id
            ? "chat_completions"
            : "anthropic_messages",
    });
  };
  push(lena.id, "mock-cheap", 0.1, 2, 0);
  push(omar.id, "mock-cheap", 0.4, 3, 0);
  push(omar.id, "mock-flash", 0.6, 2, 1);
  push(omar.id, "mock-cheap", 0.2, 1, 0);
  push(jonas.id, "mock-cheap", 0.3, 4, 0);
  push(jonas.id, "mock-cheap", 0.5, 2, 1);
  await store.recordUsage(rows);

  const createdAt = new Date(now.getTime() - 3 * DAY_MS);
  const decidedAt = new Date(now.getTime() - 2 * DAY_MS);
  const request: Request = {
    id: "req_history_omar",
    memberId: omar.id,
    teamId: team.id,
    kind: "model_unlock",
    amountUsd: null,
    modelId: "mock-flagship",
    message: "One hard refactor needs the flagship model for an afternoon.",
    state: "denied",
    context: {
      spendThisPeriodUsd: 0.6,
      limitUsd: 5,
      topModels: [{ modelId: "mock-flash", spendUsd: 0.6 }],
      last7DaysUsd: 1.2,
    },
    createdAt: toIso(createdAt),
    expiresAt: toIso(new Date(createdAt.getTime() + 72 * 60 * 60 * 1000)),
    decidedAt: toIso(decidedAt),
  };
  await store.createRequest(request);
  await store.setRequestState(request.id, "denied", toIso(decidedAt));

  const trail = new AuditTrail(store, ids, options.clock);
  await trail.record({
    actor: makeActor("member", omar.id, "Omar"),
    action: AUDIT_ACTIONS.requestCreated,
    objectType: "request",
    objectId: request.id,
    before: null,
    after: request,
    reason: null,
    at: createdAt,
  });
  await trail.record({
    actor: makeActor("manager", members.get("Priya")?.id ?? null, "Priya"),
    action: AUDIT_ACTIONS.requestDecided,
    objectType: "request",
    objectId: request.id,
    before: request,
    after: { ...request, state: "denied" },
    reason: "Use the flash model; it is enough for a refactor.",
    at: decidedAt,
  });

  const grantAt = new Date(now.getTime() - 6 * DAY_MS);
  const grant: Grant = {
    id: ids.next("grn"),
    memberId: jonas.id,
    scope: "budget",
    amountUsd: 1,
    modelId: null,
    tokenCap: null,
    requestId: null,
    issuedBy: "manager",
    issuedById: members.get("Priya")?.id ?? null,
    startsAt: toIso(grantAt),
    expiresAt: toIso(periodStart("weekly", grantAt)),
    revokedAt: toIso(new Date(grantAt.getTime() + DAY_MS)),
    createdAt: toIso(grantAt),
  };
  await store.addGrant(grant);
  await trail.record({
    actor: makeActor("manager", members.get("Priya")?.id ?? null, "Priya"),
    action: AUDIT_ACTIONS.grantRevoked,
    objectType: "grant",
    objectId: grant.id,
    before: grant,
    after: { ...grant, revokedAt: grant.revokedAt },
    reason: "The top-up was not used.",
    at: new Date(grantAt.getTime() + DAY_MS),
  });
}

export function demoPolicy(teamId: string, now: Date): TeamPolicy {
  return {
    teamId,
    offHours: {
      enabled: true,
      timeZone: "Europe/Berlin",
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 7 * 60,
      endMinute: 19 * 60,
      holidays: [],
      capUsd: 0.5,
    },
    thresholds: { softRatio: 0.8, graceRatio: 0.05 },
    unusualSpendMinUsd: 0.5,
    notifications: [
      { channel: "log", config: {}, enabled: true },
      { channel: "webhook", config: {}, enabled: true },
    ],
    updatedAt: toIso(now),
  };
}
