import type {
  Clock,
  EffectivePolicy,
  GatewayClient,
  KeyHash,
  Limits,
  Member,
  ModelEntry,
  Notification,
  NotificationKind,
  Notifier,
  Team,
  TeamPolicy,
} from "../contracts.ts";
import {
  AUDIT_ACTIONS,
  AuditTrail,
  type CoreStore,
  computeEffectivePolicy,
  defaultTeamPolicy,
  type IdSource,
  type IntervalScheduler,
  makeActor,
  periodStart,
  Reconciler,
  randomIds,
  toIso,
} from "../core/index.ts";
import { createNotifier, loadNotifyConfig, type NotifyConfig } from "../notify/index.ts";
import {
  formatUsd,
  median,
  offHoursDedupeKey,
  parseWatcherBlockReason,
  reachedThresholds,
  type ThresholdKind,
  thresholdDedupeKey,
  tokenCapDedupeKey,
  unusualDedupeKey,
  unusualSpendThreshold,
  unusualSpendTrigger,
  watcherBlockReason,
} from "./caps.ts";
import { loadWatcherConfig, type WatcherConfig } from "./config.ts";
import { formatLocal, nextWorkingStart, offHoursSegmentStart } from "./offhours.ts";
import { toUsageRows, usageSnapshot } from "./spend.ts";

/**
 * The watcher: spend polling, cap checks and threshold notifications.
 *
 * Each tick:
 *   1. poll gateway spend since the last successful poll, minus 60 s;
 *   2. persist new usage rows, de-duplicated by request id;
 *   3. unblock keys whose watcher block has expired;
 *   4. block on the token cap, the off-hours cap, or both;
 *   5. send threshold and unusual-spend notices once per period;
 *   6. reconcile every affected key through the normal reconciler path.
 *
 * Blocks are ordinary member blocks: the reconciler computes and applies the
 * desired gateway state, the audit log records actor `watcher`, and a manager
 * can unblock a member at any time.
 */

export const WATCHER_ACTOR = makeActor("watcher", "watcher", "Watcher");

export const WATCHER_AUDIT = {
  offHoursBlock: "watcher.off_hours_block",
  tokenCapBlock: "watcher.token_cap_block",
  unblocked: "watcher.unblocked",
  noticeSent: "notification.sent",
} as const;

const EPSILON = 1e-9;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WatcherDeps {
  store: CoreStore;
  gateway: GatewayClient;
  clock: Clock;
  ids?: IdSource;
  config?: WatcherConfig;
  notifyConfig?: NotifyConfig;
  env?: NodeJS.ProcessEnv;
  logger?: (line: string) => void;
  scheduler?: IntervalScheduler;
  /** One notifier for every team; tests use this. */
  notifier?: Notifier;
  /** Team-specific notifier; production wiring uses this. */
  notifyFactory?: (policy: TeamPolicy) => Notifier;
}

export interface WatchResult {
  at: string;
  newRows: number;
  blocked: string[];
  unblocked: string[];
  notifications: number;
  reconciled: boolean;
  errors: string[];
}

interface WatcherState {
  lastPollAt: Date | null;
  dedupeLoaded: boolean;
  notified: Set<string>;
  /** member id -> off-hours segment the watcher blocked for. */
  offHoursBlocks: Map<string, string>;
  /** member id -> off-hours segment a manager released. */
  offHoursReleased: Map<string, string>;
}

const defaultScheduler: IntervalScheduler = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

function periodLabel(limits: Limits): string {
  return limits.period;
}

function percentUsed(spendUsd: number, budgetUsd: number): number {
  if (budgetUsd <= 0) return 100;
  return Math.min(999, Math.floor((spendUsd / budgetUsd) * 100));
}

export class Watcher {
  private readonly store: CoreStore;
  private readonly gateway: GatewayClient;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly config: WatcherConfig;
  private readonly notifyConfig: NotifyConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: (line: string) => void;
  private readonly scheduler: IntervalScheduler;
  private readonly notifier: Notifier | null;
  private readonly notifyFactory: ((policy: TeamPolicy) => Notifier) | null;
  private readonly trail: AuditTrail;
  private readonly reconciler: Reconciler;
  private readonly state: WatcherState;
  private handle: unknown = null;
  private running = false;

  constructor(deps: WatcherDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.clock = deps.clock;
    this.ids = deps.ids ?? randomIds();
    this.config = deps.config ?? loadWatcherConfig(deps.env ?? process.env);
    this.notifyConfig = deps.notifyConfig ?? loadNotifyConfig(deps.env ?? process.env);
    this.env = deps.env ?? process.env;
    this.logger = deps.logger ?? ((line: string) => console.log(line));
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.notifier = deps.notifier ?? null;
    this.notifyFactory = deps.notifyFactory ?? null;
    this.trail = new AuditTrail(deps.store, this.ids, deps.clock);
    this.reconciler = new Reconciler({
      store: deps.store,
      gateway: deps.gateway,
      clock: deps.clock,
      ids: this.ids,
    });
    this.state = {
      lastPollAt: null,
      dedupeLoaded: false,
      notified: new Set<string>(),
      offHoursBlocks: new Map<string, string>(),
      offHoursReleased: new Map<string, string>(),
    };
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger(`watcher-error ${error instanceof Error ? error.name : "Error"}`);
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  async tick(): Promise<WatchResult> {
    const now = this.clock.now();
    const result: WatchResult = {
      at: toIso(now),
      newRows: 0,
      blocked: [],
      unblocked: [],
      notifications: 0,
      reconciled: false,
      errors: [],
    };
    if (this.running) {
      result.errors.push("a watch tick is already running");
      return result;
    }
    this.running = true;
    try {
      await this.loadDedupe(result.errors);
      try {
        result.newRows = await this.poll(now);
      } catch (error) {
        result.errors.push(`poll failed: ${error instanceof Error ? error.name : "Error"}`);
      }

      const teams = await this.store.listTeams();
      const catalogue = await this.store.listModels();
      for (const team of teams) {
        await this.evaluateTeam(team, catalogue, now, result);
      }

      try {
        await this.reconciler.run();
        result.reconciled = true;
      } catch (error) {
        result.errors.push(`reconcile failed: ${error instanceof Error ? error.name : "Error"}`);
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async loadDedupe(errors: string[]): Promise<void> {
    if (this.state.dedupeLoaded) return;
    this.state.dedupeLoaded = true;
    try {
      const events = await this.store.listAudit({ objectType: "notification", limit: 1000 });
      for (const event of events) this.state.notified.add(event.objectId);
    } catch {
      errors.push("notification history could not be read");
    }
  }

  private async poll(now: Date): Promise<number> {
    const initialFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const from =
      this.state.lastPollAt === null
        ? initialFrom
        : new Date(this.state.lastPollAt.getTime() - this.config.overlapMs);
    const spend = await this.gateway.listSpend({ from: toIso(from), to: toIso(now) });

    const membersByHash = new Map<KeyHash, Member>();
    for (const team of await this.store.listTeams()) {
      for (const member of await this.store.listMembers(team.id)) {
        if (member.keyHash !== null) membersByHash.set(member.keyHash, member);
      }
    }
    const rows = toUsageRows(spend, membersByHash);
    await this.store.recordUsage(rows);
    this.state.lastPollAt = now;
    return rows.length;
  }

  private notifierFor(policy: TeamPolicy): Notifier {
    if (this.notifier !== null) return this.notifier;
    if (this.notifyFactory !== null) return this.notifyFactory(policy);
    return createNotifier({
      config: this.notifyConfig,
      policy,
      env: this.env,
      logger: this.logger,
    });
  }

  private async evaluateTeam(
    team: Team,
    catalogue: readonly ModelEntry[],
    now: Date,
    result: WatchResult,
  ): Promise<void> {
    const policy = (await this.store.getTeamPolicy(team.id)) ?? defaultTeamPolicy(team.id, now);
    const notifier = this.notifierFor(policy);
    for (const member of await this.store.listMembers(team.id)) {
      await this.evaluateMember(team, member, policy, catalogue, notifier, now, result);
    }
  }

  private async evaluateMember(
    team: Team,
    initial: Member,
    teamPolicy: TeamPolicy,
    catalogue: readonly ModelEntry[],
    notifier: Notifier,
    now: Date,
    result: WatchResult,
  ): Promise<void> {
    if (initial.keyHash === null) return;
    const limits = await this.store.getLimits(initial.id);
    if (limits === null) return;

    let member = initial;

    // A manager unblock beside a watcher block is a deliberate release for the
    // current off-hours stretch.
    const priorSegment = this.state.offHoursBlocks.get(member.id);
    if (priorSegment !== undefined && !member.blocked) {
      this.state.offHoursReleased.set(member.id, priorSegment);
      this.state.offHoursBlocks.delete(member.id);
    }

    const scheduled = parseWatcherBlockReason(member.blockedReason);
    if (member.blocked && scheduled !== null && now.getTime() >= scheduled.until.getTime()) {
      member = await this.unblock(member, now, `the ${scheduled.kind} block reached its end`);
      result.unblocked.push(member.id);
    }

    const grants = await this.store.listGrants(member.id);
    const modelSelection = await this.store.getMemberModels(member.id);
    const windowStart = new Date(now.getTime() - 16 * DAY_MS);
    const periodStartAt = periodStart(limits.period, now);
    const from = periodStartAt.getTime() < windowStart.getTime() ? periodStartAt : windowStart;
    const rows = await this.store.listUsage({
      memberId: member.id,
      from: toIso(from),
      to: toIso(now),
    });
    const snapshot = usageSnapshot({ rows, policy: teamPolicy, limits, now });
    const effective = computeEffectivePolicy({
      member,
      limits,
      modelSelection,
      catalogue,
      teamPolicy,
      grants,
      spendThisPeriodUsd: snapshot.periodSpendUsd,
      now,
    });

    // Token cap: the watcher's own hard quota.
    if (
      !member.blocked &&
      effective.effectiveTokenCap !== null &&
      snapshot.periodTokens >= effective.effectiveTokenCap
    ) {
      const until = new Date(snapshot.periodEndIso);
      const reason = watcherBlockReason(
        "token_cap",
        `${snapshot.periodTokens} of ${effective.effectiveTokenCap} tokens this ${periodLabel(limits)}`,
        until,
      );
      member = await this.block(member, "token_cap", reason, now);
      result.blocked.push(member.id);
      const detail = `${member.displayName} used ${snapshot.periodTokens} of ${effective.effectiveTokenCap} tokens this ${periodLabel(limits)}. The key is blocked until ${until.toISOString()}.`;
      const dedupe = tokenCapDedupeKey(member.id, snapshot.periodStartIso);
      await this.notify(
        notification({
          kind: "member_blocked",
          audience: "manager",
          team,
          member,
          title: `Token cap reached: ${member.displayName}`,
          body: detail,
          link: `${this.config.publicUrl}/members/${member.id}`,
          dedupeKey: `${dedupe}:manager`,
          at: now,
          ids: this.ids,
        }),
        notifier,
        now,
        result,
      );
      await this.notify(
        notification({
          kind: "member_blocked",
          audience: "member",
          team,
          member,
          title: "Your token cap is reached",
          body: detail,
          link: `${this.config.publicUrl}/me`,
          dedupeKey: `${dedupe}:member`,
          at: now,
          ids: this.ids,
        }),
        notifier,
        now,
        result,
      );
    }

    // Off-hours cap: block the current off-hours stretch, not the next one.
    const segment = offHoursSegmentStart(now, teamPolicy.offHours);
    if (
      !member.blocked &&
      segment !== null &&
      snapshot.offHoursSpendUsd > 0 &&
      snapshot.offHoursSpendUsd + EPSILON >= teamPolicy.offHours.capUsd
    ) {
      const segmentIso = toIso(segment);
      const released = this.state.offHoursReleased.get(member.id);
      const managerReleased =
        released === segmentIso ||
        (released === undefined && (await this.managerReleasedInSegment(member.id, segment)));
      if (!managerReleased) {
        const until =
          nextWorkingStart(now, teamPolicy.offHours) ?? new Date(now.getTime() + DAY_MS);
        const reason = watcherBlockReason(
          "off_hours",
          `${formatUsd(snapshot.offHoursSpendUsd)} of ${formatUsd(teamPolicy.offHours.capUsd)} since ${formatLocal(segment, teamPolicy.offHours.timeZone)}`,
          until,
        );
        member = await this.block(member, "off_hours", reason, now);
        this.state.offHoursBlocks.set(member.id, segmentIso);
        result.blocked.push(member.id);
        const detail = `${member.displayName} spent ${formatUsd(snapshot.offHoursSpendUsd)} off-hours since ${formatLocal(segment, teamPolicy.offHours.timeZone)}, over the ${formatUsd(teamPolicy.offHours.capUsd)} cap. The key is blocked until ${formatLocal(until, teamPolicy.offHours.timeZone)} (${until.toISOString()}).`;
        const dedupe = offHoursDedupeKey(member.id, segmentIso);
        await this.notify(
          notification({
            kind: "off_hours_block",
            audience: "manager",
            team,
            member,
            title: `Off-hours cap: ${member.displayName}`,
            body: detail,
            link: `${this.config.publicUrl}/members/${member.id}`,
            dedupeKey: `${dedupe}:manager`,
            at: now,
            ids: this.ids,
          }),
          notifier,
          now,
          result,
        );
        await this.notify(
          notification({
            kind: "off_hours_block",
            audience: "member",
            team,
            member,
            title: "Off-hours cap reached",
            body: `${formatUsd(snapshot.offHoursSpendUsd)} of off-hours spend passed the ${formatUsd(teamPolicy.offHours.capUsd)} cap. Your key is blocked until ${formatLocal(until, teamPolicy.offHours.timeZone)}.`,
            link: `${this.config.publicUrl}/me`,
            dedupeKey: `${dedupe}:member`,
            at: now,
            ids: this.ids,
          }),
          notifier,
          now,
          result,
        );
      }
    }

    await this.alertThresholds(
      team,
      member,
      teamPolicy,
      effective,
      snapshot,
      notifier,
      now,
      result,
    );
    await this.alertUnusualSpend(team, member, teamPolicy, snapshot, notifier, now, result);
  }

  /**
   * With the in-memory latch gone after a restart, the audit log still proves
   * that a manager unblocked this member after the watcher blocked the current
   * off-hours stretch.
   */
  private async managerReleasedInSegment(memberId: string, segment: Date): Promise<boolean> {
    const events = await this.store.listAudit({ objectType: "member", limit: 1000 });
    const segmentTime = segment.getTime();
    let blockedAt = -1;
    let releasedAt = -1;
    for (const event of events) {
      if (event.objectId !== memberId) continue;
      const at = new Date(event.at).getTime();
      if (Number.isNaN(at) || at < segmentTime) continue;
      if (event.action === WATCHER_AUDIT.offHoursBlock) blockedAt = Math.max(blockedAt, at);
      if (event.action === AUDIT_ACTIONS.memberUnblocked) releasedAt = Math.max(releasedAt, at);
    }
    return blockedAt >= 0 && releasedAt >= blockedAt;
  }

  private async alertThresholds(
    team: Team,
    member: Member,
    teamPolicy: TeamPolicy,
    effective: EffectivePolicy,
    snapshot: ReturnType<typeof usageSnapshot>,
    notifier: Notifier,
    now: Date,
    result: WatchResult,
  ): Promise<void> {
    const budget = effective.effectiveBudgetUsd;
    if (budget <= 0) return;
    const reached = reachedThresholds(snapshot.periodSpendUsd, budget, teamPolicy.thresholds);
    for (const kind of reached) {
      const dedupe = thresholdDedupeKey(member.id, kind, snapshot.periodStartIso);
      const detail = thresholdDetail(
        kind,
        member,
        budget,
        snapshot.periodSpendUsd,
        teamPolicy,
        effective.limits.period,
      );
      const memberNotice = notification({
        kind,
        audience: "member",
        team,
        member,
        title: thresholdTitle(kind),
        body: detail,
        link: `${this.config.publicUrl}/me`,
        dedupeKey: `${dedupe}:member`,
        at: now,
        ids: this.ids,
      });
      await this.notify(memberNotice, notifier, now, result);
      if (kind === "hard_limit") {
        await this.notify(
          notification({
            kind: "member_blocked",
            audience: "manager",
            team,
            member,
            title: `Hard limit reached: ${member.displayName}`,
            body: detail,
            link: `${this.config.publicUrl}/members/${member.id}`,
            dedupeKey: `${dedupe}:manager`,
            at: now,
            ids: this.ids,
          }),
          notifier,
          now,
          result,
        );
      }
    }
  }

  private async alertUnusualSpend(
    team: Team,
    member: Member,
    teamPolicy: TeamPolicy,
    snapshot: ReturnType<typeof usageSnapshot>,
    notifier: Notifier,
    now: Date,
    result: WatchResult,
  ): Promise<void> {
    if (
      !unusualSpendTrigger(
        snapshot.todaySpendUsd,
        snapshot.previousDailyUsd,
        teamPolicy.unusualSpendMinUsd,
      )
    ) {
      return;
    }
    const threshold = unusualSpendThreshold(
      snapshot.previousDailyUsd,
      teamPolicy.unusualSpendMinUsd,
    );
    const medianValue = median(snapshot.previousDailyUsd);
    await this.notify(
      notification({
        kind: "unusual_spend",
        audience: "manager",
        team,
        member,
        title: `Unusual spend: ${member.displayName}`,
        body: `Today's spend ${formatUsd(snapshot.todaySpendUsd)} is above the unusual-spend threshold ${formatUsd(threshold)} (14-day median ${formatUsd(medianValue)}, minimum ${formatUsd(teamPolicy.unusualSpendMinUsd)}).`,
        link: `${this.config.publicUrl}/members/${member.id}`,
        dedupeKey: unusualDedupeKey(member.id, snapshot.todayKey),
        at: now,
        ids: this.ids,
      }),
      notifier,
      now,
      result,
    );
  }

  private async block(
    member: Member,
    kind: "off_hours" | "token_cap",
    reason: string,
    now: Date,
  ): Promise<Member> {
    if (member.blocked) return member;
    let updated = member;
    await this.store.transaction(async () => {
      updated = await this.store.updateMember(member.id, { blocked: true, blockedReason: reason });
      await this.trail.record({
        actor: WATCHER_ACTOR,
        action: kind === "off_hours" ? WATCHER_AUDIT.offHoursBlock : WATCHER_AUDIT.tokenCapBlock,
        objectType: "member",
        objectId: member.id,
        before: member,
        after: updated,
        reason,
        at: now,
      });
    });
    return updated;
  }

  private async unblock(member: Member, now: Date, reason: string): Promise<Member> {
    if (!member.blocked) return member;
    let updated = member;
    await this.store.transaction(async () => {
      updated = await this.store.updateMember(member.id, { blocked: false, blockedReason: null });
      await this.trail.record({
        actor: WATCHER_ACTOR,
        action: WATCHER_AUDIT.unblocked,
        objectType: "member",
        objectId: member.id,
        before: member,
        after: updated,
        reason,
        at: now,
      });
    });
    return updated;
  }

  private async notify(
    notice: Notification,
    notifier: Notifier,
    now: Date,
    result: WatchResult,
  ): Promise<void> {
    if (this.state.notified.has(notice.dedupeKey)) return;
    this.state.notified.add(notice.dedupeKey);
    let channels: string[] = [];
    try {
      const deliveries = await notifier.send(notice);
      channels = deliveries.filter((delivery) => delivery.ok).map((delivery) => delivery.channel);
    } catch (error) {
      this.logger(`notify-error ${error instanceof Error ? error.name : "Error"}`);
    }
    result.notifications += 1;
    try {
      await this.trail.record({
        actor: WATCHER_ACTOR,
        action: WATCHER_AUDIT.noticeSent,
        objectType: "notification",
        objectId: notice.dedupeKey,
        before: null,
        after: {
          kind: notice.kind,
          audience: notice.audience,
          title: notice.title,
          channels,
          teamId: notice.teamId,
          memberId: notice.memberId,
        },
        reason: notice.kind,
        at: now,
      });
    } catch (error) {
      this.logger(`audit-error ${error instanceof Error ? error.name : "Error"}`);
    }
  }
}

function thresholdTitle(kind: ThresholdKind): string {
  switch (kind) {
    case "soft_limit":
      return "Soft limit reached";
    case "grace":
      return "Budget reached: grace period";
    case "hard_limit":
      return "Hard limit reached";
  }
}

function thresholdDetail(
  kind: ThresholdKind,
  member: Member,
  budgetUsd: number,
  spendUsd: number,
  policy: TeamPolicy,
  period: Limits["period"],
): string {
  const used = `${formatUsd(spendUsd)} of ${formatUsd(budgetUsd)}`;
  switch (kind) {
    case "soft_limit":
      return `${member.displayName} passed ${percentUsed(spendUsd, budgetUsd)}% of the ${period} budget (${used}).`;
    case "grace":
      return `${member.displayName} reached the ${period} budget (${used}). Spend inside the grace share stays allowed until ${formatUsd(budgetUsd * (1 + policy.thresholds.graceRatio))}.`;
    case "hard_limit":
      return `${member.displayName} reached the hard limit (${used} plus ${Math.round(policy.thresholds.graceRatio * 100)}% grace). The gateway refuses further requests.`;
  }
}

interface NotificationInput {
  kind: NotificationKind;
  audience: Notification["audience"];
  team: Team;
  member: Member;
  title: string;
  body: string;
  link: string | null;
  dedupeKey: string;
  at: Date;
  ids: IdSource;
}

function notification(input: NotificationInput): Notification {
  return {
    id: input.ids.next("ntf"),
    at: toIso(input.at),
    kind: input.kind,
    audience: input.audience,
    teamId: input.team.id,
    memberId: input.member.id,
    title: input.title,
    body: input.body,
    link: input.link,
    dedupeKey: input.dedupeKey,
  };
}

// Re-exported for callers that need the same period helper without reaching
// into the core module.
export { periodStart };
