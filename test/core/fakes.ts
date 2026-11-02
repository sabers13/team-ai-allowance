import { createHash } from "node:crypto";
import type {
  CreatedGatewayKey,
  CreateGatewayKeyInput,
  DeliveryResult,
  DesiredKeyState,
  GatewayClient,
  GatewayKeyRef,
  GatewaySpendRow,
  Member,
  Notification,
  Notifier,
  Role,
  SpendQuery,
  Team,
  UsageRow,
  Usd,
} from "../../src/contracts.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { defaultTeamPolicy } from "../../src/core/policy.ts";
import { ControlService } from "../../src/core/service.ts";
import { GatewayError } from "../../src/gateway/errors.ts";
import { openSqliteStore, type SqliteStore } from "../../src/store/index.ts";

/** A gateway that records calls and holds the state it was given. */
export class FakeGateway implements GatewayClient {
  readonly calls: Array<{ method: string; keyAlias?: string; desired?: DesiredKeyState }> = [];
  readonly state = new Map<string, DesiredKeyState>();
  readonly teams = new Map<string, { name: string; monthlyBudgetUsd: number }>();
  /** Aliases whose `/key/delete` answers `not_found`, like an already-revoked key. */
  readonly missingDeleteAliases = new Set<string>();
  failUpdates = false;
  private teamCounter = 0;
  private keyCounter = 0;

  async createKey(input: CreateGatewayKeyInput): Promise<CreatedGatewayKey> {
    this.keyCounter += 1;
    const secret = `sk-fake-${input.keyAlias}-${this.keyCounter}`;
    this.calls.push({ method: "createKey", keyAlias: input.keyAlias });
    return { keyAlias: input.keyAlias, keyHash: hashKey(secret), secret };
  }

  async updateKey(ref: GatewayKeyRef, desired: DesiredKeyState): Promise<void> {
    this.calls.push({ method: "updateKey", keyAlias: ref.keyAlias, desired: clone(desired) });
    if (this.failUpdates) throw new Error("fake gateway refuses");
    this.state.set(ref.keyAlias, clone(desired));
  }

  async deleteKey(ref: GatewayKeyRef): Promise<void> {
    this.calls.push({ method: "deleteKey", keyAlias: ref.keyAlias });
    this.state.delete(ref.keyAlias);
    if (this.missingDeleteAliases.has(ref.keyAlias)) {
      throw new GatewayError("not_found", `No gateway key with alias ${ref.keyAlias}`);
    }
  }

  async blockKey(ref: GatewayKeyRef): Promise<void> {
    this.calls.push({ method: "blockKey", keyAlias: ref.keyAlias });
    const current = this.state.get(ref.keyAlias);
    if (current !== undefined) this.state.set(ref.keyAlias, { ...current, blocked: true });
  }

  async unblockKey(ref: GatewayKeyRef): Promise<void> {
    this.calls.push({ method: "unblockKey", keyAlias: ref.keyAlias });
    const current = this.state.get(ref.keyAlias);
    if (current !== undefined) this.state.set(ref.keyAlias, { ...current, blocked: false });
  }

  async regenerateKey(ref: GatewayKeyRef): Promise<CreatedGatewayKey> {
    this.calls.push({ method: "regenerateKey", keyAlias: ref.keyAlias });
    return { keyAlias: ref.keyAlias, keyHash: hashKey("rotated"), secret: "rotated" };
  }

  async createTeam(input: {
    name: string;
    monthlyBudgetUsd: number;
    modelIds: string[];
  }): Promise<string> {
    this.teamCounter += 1;
    const id = `gw_team_${this.teamCounter}`;
    this.teams.set(id, { name: input.name, monthlyBudgetUsd: input.monthlyBudgetUsd });
    this.calls.push({ method: `createTeam:${id}` });
    return id;
  }

  async updateTeam(
    teamId: string,
    patch: { name?: string; monthlyBudgetUsd?: number },
  ): Promise<void> {
    const team = this.teams.get(teamId);
    if (team === undefined) throw new Error(`fake gateway: unknown team ${teamId}`);
    this.teams.set(teamId, {
      name: patch.name ?? team.name,
      monthlyBudgetUsd: patch.monthlyBudgetUsd ?? team.monthlyBudgetUsd,
    });
    this.calls.push({ method: `updateTeam:${teamId}` });
  }

  async deleteTeam(teamId: string): Promise<void> {
    this.teams.delete(teamId);
    this.calls.push({ method: `deleteTeam:${teamId}` });
  }

  async addTeamMember(_teamId: string, _userId: string, _role: Role): Promise<void> {
    throw new Error("fake gateway: addTeamMember is not used in core tests");
  }

  async removeTeamMember(): Promise<void> {
    throw new Error("fake gateway: removeTeamMember is not used in core tests");
  }

  async listSpend(_query: SpendQuery): Promise<GatewaySpendRow[]> {
    return [];
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Records every notice it is asked to deliver. */
export class RecordingNotifier implements Notifier {
  readonly sent: Notification[] = [];

  async send(notification: Notification): Promise<DeliveryResult[]> {
    this.sent.push(notification);
    return [{ channel: "log", ok: true, status: null, error: null }];
  }
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface Fixture {
  store: SqliteStore;
  gateway: FakeGateway;
  clock: ManualClock;
  service: ControlService;
  team: Team;
  member: Member;
  addSpend(amountUsd: Usd, modelId?: string): Promise<void>;
  close(): void;
}

export const START = "2026-10-05T09:00:00Z"; // a Monday

export async function makeFixture(
  options: { budgetUsd?: Usd; withKey?: boolean; notifier?: Notifier } = {},
): Promise<Fixture> {
  const clock = new ManualClock(START);
  const store = openSqliteStore({ path: ":memory:", clock });
  const gateway = new FakeGateway();
  const service = new ControlService({
    store,
    gateway,
    clock,
    ids: sequentialIds(),
    ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
  });

  const team = await store.createTeam({ name: "Platform", monthlyBudgetUsd: 500 });
  const policy = defaultTeamPolicy(team.id, clock.now());
  policy.thresholds = { softRatio: 0.8, graceRatio: 0.05 };
  await store.setTeamPolicy(policy);

  for (const model of [
    {
      id: "gpt-6-luna",
      displayName: "Luna",
      route: "mock/luna",
      state: "enabled" as const,
      sortOrder: 1,
    },
    {
      id: "deepseek-v4.1-flash",
      displayName: "Flash",
      route: "mock/flash",
      state: "enabled" as const,
      sortOrder: 2,
    },
    {
      id: "flagship",
      displayName: "Flagship",
      route: "mock/flagship",
      state: "approval-required" as const,
      sortOrder: 3,
    },
    {
      id: "blocked-model",
      displayName: "Blocked",
      route: "mock/blocked",
      state: "blocked" as const,
      sortOrder: 4,
    },
  ]) {
    await store.upsertModel({
      id: model.id,
      displayName: model.displayName,
      route: model.route,
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
    keyHash: options.withKey === false ? null : hashKey("test-key-lena"),
    blocked: false,
    blockedReason: null,
  });
  // The frozen key alias is `taa-<memberId>`; the id is generated by the store.
  const member = await store.updateMember(created.id, { keyAlias: `taa-${created.id}` });
  await store.setLimits(member.id, {
    budgetUsd: options.budgetUsd ?? 20,
    period: "daily",
    tokenCap: null,
    rpm: null,
    tpm: null,
  });

  let usageCounter = 0;
  const addSpend = async (amountUsd: Usd, modelId = "gpt-6-luna"): Promise<void> => {
    usageCounter += 1;
    const row: UsageRow = {
      id: `use_${usageCounter}`,
      memberId: member.id,
      modelId,
      at: clock.now().toISOString(),
      inputTokens: 100,
      outputTokens: 50,
      costUsd: amountUsd,
      requestId: `gw_${usageCounter}`,
    };
    await store.recordUsage([row]);
  };

  return {
    store,
    gateway,
    clock,
    service,
    team,
    member,
    addSpend,
    close: () => store.close(),
  };
}
