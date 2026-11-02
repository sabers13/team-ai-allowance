import { createHash } from "node:crypto";
import type {
  DeliveryResult,
  GatewaySpendRow,
  Limits,
  Member,
  Notification,
  Notifier,
  OffHoursPolicy,
  Period,
  SpendQuery,
  Team,
  TeamPolicy,
  Thresholds,
  UsageRow,
} from "../../src/contracts.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { defaultTeamPolicy } from "../../src/core/policy.ts";
import { openSqliteStore, type SqliteStore } from "../../src/store/index.ts";
import { Watcher } from "../../src/watcher/index.ts";
import { FakeGateway } from "../core/fakes.ts";

const KEY = "test-key-lena";

export function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SpendGateway extends FakeGateway {
  readonly spend = new Map<string, GatewaySpendRow>();

  override async listSpend(query: SpendQuery): Promise<GatewaySpendRow[]> {
    return [...this.spend.values()].filter((row) => {
      const at = new Date(row.endedAt ?? row.startedAt).getTime();
      return at >= new Date(query.from).getTime() && at <= new Date(query.to).getTime();
    });
  }
}

export class RecordingNotifier implements Notifier {
  readonly sent: Notification[] = [];

  async send(notification: Notification): Promise<DeliveryResult[]> {
    this.sent.push(notification);
    return [{ channel: "log", ok: true, status: null, error: null }];
  }

  byKind(kind: Notification["kind"]): Notification[] {
    return this.sent.filter((notice) => notice.kind === kind);
  }
}

export interface WatchFixtureOptions {
  start: string;
  budgetUsd?: number;
  tokenCap?: number | null;
  period?: Period;
  offHours?: Partial<OffHoursPolicy>;
  thresholds?: Thresholds;
  unusualSpendMinUsd?: number;
}

export interface WatchFixture {
  store: SqliteStore;
  gateway: SpendGateway;
  clock: ManualClock;
  notifier: RecordingNotifier;
  team: Team;
  memberId: string;
  keyHash: string;
  policy: TeamPolicy;
  limits: Limits;
  addSpend(input: {
    requestId: string;
    costUsd: number;
    at?: string;
    tokens?: number;
    modelId?: string;
  }): void;
  addStoredUsage(input: {
    id: string;
    costUsd: number;
    at: string;
    tokens?: number;
    modelId?: string;
  }): Promise<void>;
  latestMember(): Promise<Member>;
  watcher(): Watcher;
  close(): void;
}

export async function makeWatchFixture(options: WatchFixtureOptions): Promise<WatchFixture> {
  const clock = new ManualClock(options.start);
  const store = openSqliteStore({ path: ":memory:", clock });
  const gateway = new SpendGateway();
  const notifier = new RecordingNotifier();

  const team = await store.createTeam({ name: "Platform", monthlyBudgetUsd: 500 });
  const policy = defaultTeamPolicy(team.id, clock.now());
  policy.thresholds = options.thresholds ?? { softRatio: 0.8, graceRatio: 0.05 };
  policy.offHours = { ...policy.offHours, ...options.offHours };
  policy.unusualSpendMinUsd = options.unusualSpendMinUsd ?? 1000;
  await store.setTeamPolicy(policy);

  for (const model of [
    { id: "gpt-6-luna", displayName: "Luna", state: "enabled" as const, sortOrder: 1 },
    { id: "flagship", displayName: "Flagship", state: "approval-required" as const, sortOrder: 2 },
  ]) {
    await store.upsertModel({
      id: model.id,
      displayName: model.displayName,
      route: `mock/${model.id}`,
      inputPer1MUsd: 1,
      outputPer1MUsd: 2,
      state: model.state,
      sortOrder: model.sortOrder,
    });
  }

  const created = await store.createMember({
    teamId: team.id,
    displayName: "Lena",
    email: null,
    role: "member",
    keyAlias: "taa-pending",
    keyHash: hash(KEY),
    blocked: false,
    blockedReason: null,
  });
  const member = await store.updateMember(created.id, { keyAlias: `taa-${created.id}` });
  const limits: Limits = {
    budgetUsd: options.budgetUsd ?? 10,
    period: options.period ?? "daily",
    tokenCap: options.tokenCap ?? null,
    rpm: null,
    tpm: null,
  };
  await store.setLimits(member.id, limits);

  const addSpend: WatchFixture["addSpend"] = (input) => {
    const at = input.at ?? clock.now().toISOString();
    gateway.spend.set(input.requestId, {
      requestId: input.requestId,
      keyHash: hash(KEY),
      teamId: team.id,
      userId: member.id,
      model: input.modelId ?? "gpt-6-luna",
      spendUsd: input.costUsd,
      promptTokens: Math.floor((input.tokens ?? 150) / 3),
      completionTokens: (input.tokens ?? 150) - Math.floor((input.tokens ?? 150) / 3),
      totalTokens: input.tokens ?? 150,
      startedAt: at,
      endedAt: at,
    });
  };

  const addStoredUsage: WatchFixture["addStoredUsage"] = async (input) => {
    const total = input.tokens ?? 150;
    const row: UsageRow = {
      id: input.id,
      memberId: member.id,
      modelId: input.modelId ?? "gpt-6-luna",
      at: input.at,
      inputTokens: Math.floor(total / 3),
      outputTokens: total - Math.floor(total / 3),
      costUsd: input.costUsd,
      requestId: input.id,
    };
    await store.recordUsage([row]);
  };

  const watcher = (): Watcher =>
    new Watcher({
      store,
      gateway,
      clock,
      ids: sequentialIds(),
      notifier,
      config: { intervalMs: 30_000, overlapMs: 60_000, publicUrl: "https://console.test" },
      env: {},
      notifyConfig: {
        teamsUrl: null,
        slackUrl: null,
        webhookUrl: null,
        smtpUrl: null,
        mailFrom: "taa@test",
        mailTo: null,
        timeoutMs: 1000,
      },
    });

  return {
    store,
    gateway,
    clock,
    notifier,
    team,
    memberId: member.id,
    keyHash: hash(KEY),
    policy,
    limits,
    addSpend,
    addStoredUsage,
    latestMember: async () => {
      const latest = await store.getMember(member.id);
      if (latest === null) throw new Error("member disappeared");
      return latest;
    },
    watcher,
    close: () => store.close(),
  };
}
