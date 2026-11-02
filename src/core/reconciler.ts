import {
  type Clock,
  type DesiredKeyState,
  type EffectivePolicy,
  type GatewayClient,
  type GatewayKeyRef,
  type Grant,
  type KeyAlias,
  type Limits,
  type Member,
  type MemberId,
  type ModelEntry,
  RECONCILE_INTERVAL_MS,
  type TeamPolicy,
  type Usd,
} from "../contracts.ts";
import { AUDIT_ACTIONS, AuditTrail, RECONCILER_ACTOR } from "./audit.ts";
import { DomainError } from "./errors.ts";
import type { IdSource } from "./ids.ts";
import { computeDesiredKeyState, computeEffectivePolicy, defaultTeamPolicy } from "./policy.ts";
import type { CoreStore } from "./ports.ts";
import { periodStart, toIso } from "./time.ts";

/**
 * The reconciler: computes desired gateway key state and applies minimal diffs.
 *
 * Pure part: compute the desired key state per member, then the minimal diff
 * against the state the gateway already holds.
 * Impure part: apply only changed keys through `GatewayClient`, persist the new
 * state and append one audit event per change. Running it twice with no change
 * makes no gateway call and appends nothing.
 */

export interface ReconcilerMemberInput {
  member: Member;
  limits: Limits;
  modelSelection: readonly string[];
  spendThisPeriodUsd: Usd;
  grants: readonly Grant[];
}

export interface DesiredStateInput {
  members: readonly ReconcilerMemberInput[];
  catalogue: readonly ModelEntry[];
  teamPolicies: readonly TeamPolicy[];
  now: Date;
}

export function desiredState(input: DesiredStateInput): DesiredKeyState[] {
  const policies = new Map(input.teamPolicies.map((policy) => [policy.teamId, policy]));
  const states: DesiredKeyState[] = [];
  for (const memberInput of input.members) {
    if (memberInput.member.keyHash === null) continue;
    const teamPolicy =
      policies.get(memberInput.member.teamId) ??
      defaultTeamPolicy(memberInput.member.teamId, input.now);
    const policy = computeEffectivePolicy({
      member: memberInput.member,
      limits: memberInput.limits,
      modelSelection: memberInput.modelSelection,
      catalogue: input.catalogue,
      teamPolicy,
      grants: memberInput.grants,
      spendThisPeriodUsd: memberInput.spendThisPeriodUsd,
      now: input.now,
    });
    states.push(computeDesiredKeyState(policy, teamPolicy.thresholds.graceRatio));
  }
  return states.sort((a, b) => a.keyAlias.localeCompare(b.keyAlias));
}

export type KeyStateField =
  | "models"
  | "maxBudgetUsd"
  | "budgetDuration"
  | "tpmLimit"
  | "rpmLimit"
  | "blocked";

export interface KeyStateDiff {
  keyAlias: KeyAlias;
  before: DesiredKeyState | null;
  after: DesiredKeyState;
  fields: KeyStateField[];
}

const FIELD_ORDER: readonly KeyStateField[] = [
  "models",
  "maxBudgetUsd",
  "budgetDuration",
  "tpmLimit",
  "rpmLimit",
  "blocked",
];

function sameModels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function changedFields(before: DesiredKeyState | null, after: DesiredKeyState): KeyStateField[] {
  if (before === null) return [...FIELD_ORDER];
  const fields: KeyStateField[] = [];
  if (!sameModels(before.models, after.models)) fields.push("models");
  if (before.maxBudgetUsd !== after.maxBudgetUsd) fields.push("maxBudgetUsd");
  if (before.budgetDuration !== after.budgetDuration) fields.push("budgetDuration");
  if (before.tpmLimit !== after.tpmLimit) fields.push("tpmLimit");
  if (before.rpmLimit !== after.rpmLimit) fields.push("rpmLimit");
  if (before.blocked !== after.blocked) fields.push("blocked");
  return fields;
}

/** Only keys that differ. A key that is missing is a full change. */
export function diff(
  current: readonly DesiredKeyState[],
  desired: readonly DesiredKeyState[],
): KeyStateDiff[] {
  const byAlias = new Map(current.map((state) => [state.keyAlias, state]));
  const changes: KeyStateDiff[] = [];
  for (const after of [...desired].sort((a, b) => a.keyAlias.localeCompare(b.keyAlias))) {
    const before = byAlias.get(after.keyAlias) ?? null;
    const fields = changedFields(before, after);
    if (fields.length > 0) changes.push({ keyAlias: after.keyAlias, before, after, fields });
  }
  return changes;
}

export interface LoadedDesiredState {
  desired: DesiredKeyState[];
  refs: Map<KeyAlias, GatewayKeyRef>;
  policies: Map<MemberId, EffectivePolicy>;
}

/** Read everything the pure functions need and build the desired state. */
export async function loadDesiredState(store: CoreStore, now: Date): Promise<LoadedDesiredState> {
  const catalogue = await store.listModels();
  const teams = await store.listTeams();
  const teamPolicies: TeamPolicy[] = [];
  for (const team of teams) {
    const policy = await store.getTeamPolicy(team.id);
    teamPolicies.push(policy ?? defaultTeamPolicy(team.id, now));
  }

  const members: ReconcilerMemberInput[] = [];
  const refs = new Map<KeyAlias, GatewayKeyRef>();
  const policies = new Map<MemberId, EffectivePolicy>();

  for (const team of teams) {
    const teamMembers = await store.listMembers(team.id);
    for (const member of teamMembers) {
      const limits = await store.getLimits(member.id);
      if (limits === null) continue;
      if (member.keyHash === null) continue;

      const from = toIso(periodStart(limits.period, now));
      const usage = await store.listUsage({ memberId: member.id, from, to: toIso(now) });
      const spendThisPeriodUsd = usage.reduce((sum, row) => sum + row.costUsd, 0);
      const grants = await store.listGrants(member.id);
      const modelSelection = await store.getMemberModels(member.id);

      members.push({ member, limits, modelSelection, spendThisPeriodUsd, grants });
      refs.set(member.keyAlias, { keyAlias: member.keyAlias, keyHash: member.keyHash });

      const teamPolicy =
        teamPolicies.find((policy) => policy.teamId === member.teamId) ??
        defaultTeamPolicy(member.teamId, now);
      policies.set(
        member.id,
        computeEffectivePolicy({
          member,
          limits,
          modelSelection,
          catalogue,
          teamPolicy,
          grants,
          spendThisPeriodUsd,
          now,
        }),
      );
    }
  }

  return { desired: desiredState({ members, catalogue, teamPolicies, now }), refs, policies };
}

async function applyChange(
  gateway: GatewayClient,
  ref: GatewayKeyRef,
  change: KeyStateDiff,
): Promise<number> {
  let calls = 0;
  const nonBlocked = change.fields.filter((field) => field !== "blocked");
  if (change.before === null || nonBlocked.length > 0) {
    await gateway.updateKey(ref, change.after);
    calls += 1;
  }
  const wasBlocked = change.before?.blocked ?? false;
  if (change.after.blocked !== wasBlocked) {
    if (change.after.blocked) await gateway.blockKey(ref);
    else await gateway.unblockKey(ref);
    calls += 1;
  }
  return calls;
}

export interface ReconcilerDeps {
  store: CoreStore;
  gateway: GatewayClient;
  clock: Clock;
  ids: IdSource;
}

export interface ReconcileFailure {
  keyAlias: KeyAlias;
  message: string;
}

export interface ReconcileResult {
  desired: number;
  changes: KeyStateDiff[];
  applied: KeyStateDiff[];
  failures: ReconcileFailure[];
  gatewayCalls: number;
}

export class Reconciler {
  private readonly store: CoreStore;
  private readonly gateway: GatewayClient;
  private readonly clock: Clock;
  private readonly trail: AuditTrail;

  constructor(deps: ReconcilerDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.clock = deps.clock;
    this.trail = new AuditTrail(deps.store, deps.ids, deps.clock);
  }

  async run(): Promise<ReconcileResult> {
    const now = this.clock.now();
    const loaded = await loadDesiredState(this.store, now);
    const current = await this.store.listKeyStates();
    const changes = diff(current, loaded.desired);

    const applied: KeyStateDiff[] = [];
    const failures: ReconcileFailure[] = [];
    let gatewayCalls = 0;

    for (const change of changes) {
      const ref = loaded.refs.get(change.keyAlias);
      if (ref === undefined) continue;
      try {
        gatewayCalls += await applyChange(this.gateway, ref, change);
        await this.store.transaction(async () => {
          await this.store.setKeyState(change.after, toIso(now));
          await this.trail.record({
            actor: RECONCILER_ACTOR,
            action: AUDIT_ACTIONS.keyStateApplied,
            objectType: "key",
            objectId: change.keyAlias,
            before: change.before,
            after: change.after,
            reason: `reconciler applied: ${change.fields.join(", ")}`,
            at: now,
          });
        });
        applied.push(change);
      } catch {
        failures.push({
          keyAlias: change.keyAlias,
          message: "the gateway refused the key update",
        });
        await this.trail.record({
          actor: RECONCILER_ACTOR,
          action: AUDIT_ACTIONS.keyStateFailed,
          objectType: "key",
          objectId: change.keyAlias,
          before: change.before,
          after: null,
          reason: "the gateway refused the key update",
          at: now,
        });
      }
    }

    if (failures.length > 0) {
      throw new DomainError("gateway_failure", "The reconciler could not apply every key update.", {
        failures,
      });
    }

    return {
      desired: loaded.desired.length,
      changes,
      applied,
      failures,
      gatewayCalls,
    };
  }
}

export interface IntervalScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultScheduler: IntervalScheduler = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface LoopOptions {
  intervalMs?: number;
  scheduler?: IntervalScheduler;
  onError?: (error: unknown) => void;
}

/**
 * Runs the reconciler after a change (direct `run`) and on the interval
 * (`RECONCILE_INTERVAL_MS` by default). One tick at a time: a slow gateway call
 * never stacks ticks.
 */
export class ReconciliationLoop {
  private readonly reconciler: Reconciler;
  private readonly intervalMs: number;
  private readonly scheduler: IntervalScheduler;
  private readonly onError: ((error: unknown) => void) | undefined;
  private handle: unknown = null;
  private running = false;

  constructor(reconciler: Reconciler, options: LoopOptions = {}) {
    this.reconciler = reconciler;
    this.intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
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

  async tick(): Promise<ReconcileResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.reconciler.run();
    } catch (error) {
      if (this.onError !== undefined) this.onError(error);
      else throw error;
      return null;
    } finally {
      this.running = false;
    }
  }
}
