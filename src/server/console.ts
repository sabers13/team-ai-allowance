/**
 * The console wiring: `ConsoleData`, `ConsoleActions` and `ConsoleAuth` over
 * the control service, the store and the auth stores.
 *
 * The console module is transport- and storage-neutral. Everything here is
 * an adapter, so the pages keep working against fixtures in their own tests and
 * against real data in `taa serve`.
 *
 * One console is built per request, because the viewer decides both the team
 * scope and the audit actor. Nothing else is per-request.
 */

import type { Actor, ControlPort } from "../api/index.ts";
import {
  type CredentialStore,
  clearedCookie,
  type LoginRateLimiter,
  SESSION_COOKIE,
  type Session,
  type SessionStore,
  safeEqual,
  sha256Hex,
  signSessionCookie,
  verifyPassword,
  verifySessionCookie,
} from "../auth/index.ts";
import {
  ConsoleActionError,
  type ConsoleActions,
  type ConsoleAuth,
  type ConsoleData,
  type LoginResult,
  type Viewer,
} from "../console/index.ts";
import { buildUsageReport, usagePeriodFor } from "../console/usage/index.ts";
import type {
  AuditEvent,
  Clock,
  GatewayClient,
  Limits,
  Member,
  ModelEntry,
  Notification,
  Team,
  TeamPolicy,
  UsageRow,
} from "../contracts.ts";
import { type CoreStore, defaultTeamPolicy, periodEnd, periodStart, toIso } from "../core/index.ts";
import type { ModelHint } from "../mcp/index.ts";
import { managedFiles, type SetupSpec } from "../setup/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 30;

/**
 * A real scrypt hash of a throwaway password. An unknown e-mail is verified
 * against it so the request does the same work as a known account and the
 * response time does not reveal whether the account exists.
 */
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$f16d1684b53a7fc19196f017c43a7bc2$7d8e9153eaa31cf98ba22e5065703c93fd671665cd26bbb8a1c1083fb5a09f41febf17d9a2665a4612bc51a789144017f443ace9aa69a0d84f58a9edbb57a421";

export interface ConsoleWiringDeps {
  control: ControlPort;
  store: CoreStore;
  gateway: GatewayClient;
  clock: Clock;
  credentials: CredentialStore;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  sessionSecret: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  controlUrl: string;
  gatewayUrl: string;
  hints: readonly ModelHint[];
  timeZone: string;
}

export interface ConsolePorts {
  data: ConsoleData;
  actions: ConsoleActions;
  auth: ConsoleAuth;
}

function money(value: number): string {
  return `USD ${value.toFixed(2)}`;
}

function sumCost(rows: readonly UsageRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + row.costUsd, 0) * 1_000_000) / 1_000_000;
}

function monthlyPeriod(limits: Limits): string {
  return limits.period === "daily"
    ? "Today"
    : limits.period === "weekly"
      ? "This week"
      : "This month";
}

function alertOf(teamId: string, event: AuditEvent): Notification {
  return {
    id: `alert_${event.id}`,
    at: event.at,
    kind: "unusual_spend",
    audience: "manager",
    teamId,
    memberId: event.objectType === "member" ? event.objectId : null,
    title: event.action,
    body: event.reason ?? `${event.objectType} ${event.objectId}`,
    link: null,
    dedupeKey: event.id,
  };
}

function hintFor(hints: readonly ModelHint[], modelId: string | null): string | null {
  if (modelId === null) return null;
  const hint = hints.find((entry) => entry.modelId === modelId);
  if (hint === undefined || hint.instead.length === 0) return null;
  const instead = hint.instead.join(" or ");
  return hint.note === null
    ? `A cheaper model can do this job: ${instead}.`
    : `A cheaper model can do this job: ${instead}. ${hint.note}`;
}

/** True when an event is about this member, whoever acted. */
function isAboutMember(event: AuditEvent, member: Member): boolean {
  if (event.objectType === "key") return event.objectId === member.keyAlias;
  if (event.objectType === "request") {
    const after = event.after;
    return (
      typeof after === "object" &&
      after !== null &&
      (after as { memberId?: unknown }).memberId === member.id
    );
  }
  return (
    (event.objectType === "member" ||
      event.objectType === "limits" ||
      event.objectType === "member_models") &&
    event.objectId === member.id
  );
}

export function createConsolePorts(deps: ConsoleWiringDeps, viewer: Viewer | null): ConsolePorts {
  const { control, store, clock, gateway } = deps;
  const teamId = viewer?.teamId ?? "";
  const actor: Actor = {
    memberId: viewer?.memberId ?? "",
    teamId,
    role: viewer?.role ?? "manager",
    via: "session",
  };

  async function teamOrThrow(): Promise<Team> {
    const team = await control.getTeam(teamId);
    if (team === null) throw new ConsoleActionError("Team not found.", 404);
    return team;
  }

  async function policyOf(memberId: string) {
    const me = await control.getMe(memberId);
    return me.policy;
  }

  async function usageWindow(): Promise<UsageRow[]> {
    const now = clock.now();
    return control.listUsage({
      teamId,
      from: toIso(new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS)),
      to: toIso(now),
    });
  }

  async function membersOf(): Promise<Member[]> {
    return control.listMembers(teamId);
  }

  /**
   * The URL carries a member id; the session carries the viewer's team. Every
   * manager form checks the two agree before the control service is called, so
   * a console URL cannot cross teams.
   */
  async function requireMemberInTeam(memberId: string): Promise<void> {
    const member = await control.getMember(memberId);
    if (member === null || member.teamId !== teamId) {
      throw new ConsoleActionError("That member is not in this team.", 404);
    }
  }

  const data: ConsoleData = {
    async overview(sort) {
      const team = await teamOrThrow();
      const now = clock.now();
      const [overview, usage, policy] = await Promise.all([
        control.getTeamOverview(teamId),
        usageWindow(),
        control.getTeamPolicy(teamId),
      ]);
      const models = overview.models;
      const openRequests = overview.openRequests;
      const teamPolicy = policy ?? defaultTeamPolicy(teamId, now);
      const monthByMember = new Map<string, number>();
      for (const row of usage) {
        monthByMember.set(row.memberId, (monthByMember.get(row.memberId) ?? 0) + row.costUsd);
      }
      const members = overview.members.map((row) => ({
        member: row.member,
        policy: row.policy,
        spendUsd: row.spendUsd,
        monthSpendUsd: Math.round((monthByMember.get(row.member.id) ?? 0) * 100) / 100,
      }));
      if (sort.direction === "asc") members.reverse();
      const byModel = new Map<string, { spendUsd: number; requests: number }>();
      for (const row of usage) {
        const entry = byModel.get(row.modelId) ?? { spendUsd: 0, requests: 0 };
        entry.spendUsd += row.costUsd;
        entry.requests += 1;
        byModel.set(row.modelId, entry);
      }
      const limits = overview.members[0]?.policy.limits ?? { period: "monthly" as const };
      return {
        team,
        teamPolicy,
        members,
        models,
        openRequests,
        alerts: overview.alerts.slice(0, 4).map((alert) =>
          alertOf(teamId, {
            id: `${alert.kind}-${alert.at}`,
            at: alert.at,
            actor: { type: "system", id: null, displayName: null },
            action: alert.kind,
            objectType: "team",
            objectId: teamId,
            before: null,
            after: null,
            reason: alert.message,
          }),
        ),
        spendByModel: models.map((model) => ({
          modelId: model.id,
          modelName: model.displayName,
          spendUsd: Math.round((byModel.get(model.id)?.spendUsd ?? 0) * 100) / 100,
          requests: byModel.get(model.id)?.requests ?? 0,
        })),
        teamSpendUsd:
          Math.round(
            [...monthByMember.values()].reduce((sum, value) => sum + value, 0) * 1_000_000,
          ) / 1_000_000,
        periodLabel: monthlyPeriod(limits as Limits),
        periodEndsAt: toIso(periodEnd("monthly", now)),
      };
    },

    async members() {
      return membersOf();
    },

    async requests(filter) {
      return control.listRequests({
        teamId,
        limit: filter.limit,
        ...(filter.state === "all" ? {} : { state: filter.state }),
        ...(filter.memberId === null ? {} : { memberId: filter.memberId }),
      });
    },

    async requestCounts() {
      const [pending, decided] = await Promise.all([
        control.listRequests({ teamId, state: "pending", limit: 500 }),
        control.listRequests({ teamId, limit: 500 }),
      ]);
      return { inbox: pending.length, history: decided.length - pending.length };
    },

    async requestDetail(id) {
      const request = await control.getRequest(id);
      if (request === null || request.teamId !== teamId) return null;
      const member = await control.getMember(request.memberId);
      if (member === null) return null;
      return {
        request,
        member,
        decisions: await store.listDecisions(id),
        hint: hintFor(deps.hints, request.modelId),
      };
    },

    async memberDetail(id) {
      const detail = await control.getMemberDetail(teamId, id);
      if (detail === null) return null;
      const [selectedModelIds, events] = await Promise.all([
        store.getMemberModels(id),
        store.listAudit({ teamId, limit: 200 }),
      ]);
      const audit = events.filter((event) => isAboutMember(event, detail.member));
      const rotation = events.find(
        (event) => event.action === "key.rotated" && event.objectId === id,
      );
      return {
        member: detail.member,
        team: await teamOrThrow(),
        policy: detail.policy,
        limits: detail.limits,
        selectedModelIds,
        spendUsd: await periodSpend(id),
        grants: detail.grants,
        usage: detail.usage,
        audit: audit.slice(0, 50),
        keyState: {
          active: detail.member.keyHash !== null && detail.policy.status !== "blocked",
          blocked: detail.member.blocked,
          status: detail.policy.status,
          reason: detail.policy.blockedReason ?? detail.member.blockedReason,
          lastRotatedAt: rotation?.at ?? null,
        },
      };
    },

    async models() {
      const [catalogue, usage, members] = await Promise.all([
        store.listModels(),
        usageWindow(),
        membersOf(),
      ]);
      const policies = await Promise.all(members.map((member) => policyOf(member.id)));
      const perModel = new Map<string, number>();
      for (const row of usage) {
        perModel.set(row.modelId, (perModel.get(row.modelId) ?? 0) + 1);
      }
      return {
        models: catalogue.map((model) => ({
          model,
          requestsLast30Days: perModel.get(model.id) ?? 0,
          membersAllowed: policies.filter((policy) => policy.allowedModels.includes(model.id))
            .length,
        })),
      };
    },

    async rules() {
      const [rules, policy] = await Promise.all([
        control.listRules(teamId),
        control.getTeamPolicy(teamId),
      ]);
      return { rules, policy: policy ?? defaultTeamPolicy(teamId, clock.now()) };
    },

    async audit(filter) {
      const rows = await store.listAudit({
        teamId,
        limit: filter.limit + filter.offset,
        ...(filter.actorId === null ? {} : { actorId: filter.actorId }),
        ...(filter.objectType === null ? {} : { objectType: filter.objectType }),
        ...(filter.objectId === null ? {} : { objectId: filter.objectId }),
        ...(filter.from === null ? {} : { from: filter.from }),
        ...(filter.to === null ? {} : { to: filter.to }),
      });
      return rows.slice(filter.offset);
    },

    async auditActors() {
      const events = await store.listAudit({ teamId, limit: 500 });
      const seen = new Map<string, string>();
      for (const event of events) {
        const id = event.actor.id;
        if (id === null) continue;
        if (!seen.has(id)) seen.set(id, event.actor.displayName ?? id);
      }
      return [...seen.entries()].map(([id, name]) => ({ id, name }));
    },

    async setup() {
      const [team, members, healthy] = await Promise.all([
        teamOrThrow(),
        membersOf(),
        gateway.healthy().catch(() => false),
      ]);
      const now = clock.now();
      const rows = [];
      for (const member of members) {
        rows.push({
          member,
          policy: await policyOf(member.id),
          spendUsd: await periodSpend(member.id),
          reports: [],
        });
      }
      const models = await store.listModels();
      const spec = setupSpec(team, models, members[0] ?? null);
      return {
        team,
        members: rows,
        gatewayHealthy: healthy,
        gatewayCheckedAt: toIso(now),
        packVersion: "1",
        packFiles: models.length === 0 ? [] : managedFiles(spec).map((file) => file.source),
      };
    },

    async me(current) {
      if (current.memberId === null) return null;
      const member = await control.getMember(current.memberId);
      if (member === null) return null;
      const [team, policy, usage, requests] = await Promise.all([
        teamOrThrow(),
        policyOf(member.id),
        control.listUsage({
          memberId: member.id,
          from: toIso(new Date(clock.now().getTime() - USAGE_WINDOW_DAYS * DAY_MS)),
          to: toIso(clock.now()),
        }),
        control.listRequests({ memberId: member.id, limit: 50 }),
      ]);
      const catalogue = await store.listModels();
      return {
        member,
        team,
        policy,
        spendUsd: await periodSpend(member.id),
        requests,
        usage,
        allowedModels: catalogue.filter(
          (model) => model.state !== "blocked" && policy.allowedModels.includes(model.id),
        ),
        resetAt: toIso(periodEnd(policy.limits.period, clock.now())),
      };
    },

    async openRequestCount() {
      if (teamId === "") return 0;
      return (await control.listRequests({ teamId, state: "pending", limit: 500 })).length;
    },

    async usage(query) {
      const now = clock.now();
      const period = usagePeriodFor(query, now, deps.timeZone);
      const listedTeams =
        viewer?.role === "admin" ? (await control.listTeams()).map((row) => row.id) : [];
      const teamIds = listedTeams.length > 0 ? listedTeams : [teamId];
      const [overviews, usageLists, models] = await Promise.all([
        Promise.all(teamIds.map((id) => control.getTeamOverview(id))),
        Promise.all(
          teamIds.map((id) =>
            control.listUsage({
              teamId: id,
              from: period.from.toISOString(),
              to: period.to.toISOString(),
            }),
          ),
        ),
        store.listModels(),
      ]);
      const members = overviews.flatMap((overview) =>
        overview.members.map((row) => ({
          id: row.member.id,
          displayName: row.member.displayName,
          status: row.policy.status,
          limitUsd: row.policy.effectiveBudgetUsd,
        })),
      );
      const scopeLabel =
        viewer?.role === "admin"
          ? `All teams (${teamIds.length})`
          : `${overviews[0]?.team.name ?? viewer?.teamName ?? "Team"} team`;
      return buildUsageReport({
        query,
        now,
        timeZone: deps.timeZone,
        scopeLabel,
        members,
        models,
        usage: usageLists.flat(),
      });
    },

    async bundle(memberId) {
      const bundle = await control.configBundle(teamId, memberId);
      return {
        filename: `taa-${memberId}-bundle.json`,
        contentType: "application/json; charset=utf-8",
        body: `${JSON.stringify(bundle, null, 2)}\n`,
      };
    },

    async modelCatalogue(): Promise<ModelEntry[]> {
      return store.listModels();
    },
  };

  async function periodSpend(memberId: string): Promise<number> {
    const limits = (await store.getLimits(memberId)) ?? { period: "monthly" as const };
    const now = clock.now();
    const rows = await control.listUsage({
      memberId,
      from: toIso(periodStart(limits.period, now)),
      to: toIso(now),
    });
    return sumCost(rows);
  }

  function setupSpec(team: Team, models: ModelEntry[], member: Member | null): SetupSpec {
    return {
      team: {
        name: team.name,
        gatewayUrl: deps.gatewayUrl,
        providerId: "team-gateway",
        defaultModel: models[0]?.id ?? "mock-cheap",
        models: models.map((model) => ({ id: model.id, displayName: model.displayName })),
        controlUrl: deps.controlUrl,
        mcp: { command: "taa", args: ["mcp"] },
        pluginPath: null,
        security: {},
      },
      member: {
        id: member?.id ?? "none",
        displayName: member?.displayName ?? "No member yet",
        email: member?.email ?? null,
      },
    };
  }

  const actions: ConsoleActions = {
    async decide(requestId, input) {
      const request = await control.getRequest(requestId);
      if (request === null || request.teamId !== teamId) {
        throw new ConsoleActionError("Request not found.", 404);
      }
      const result = await control.decideRequest(actor, requestId, {
        outcome: input.outcome,
        note: input.note,
        amountUsd: input.amountUsd,
        modelId: input.modelId ?? request.modelId,
        until: input.until,
        permanent: input.permanent,
      });
      return {
        message:
          result.request.state === "partly_approved"
            ? `Partly approved. ${result.request.amountUsd === null ? "" : money(result.request.amountUsd)}`
            : result.request.state === "approved"
              ? "Approved."
              : "Denied.",
        secret: null,
        memberId: result.request.memberId,
      };
    },

    async updateLimits(memberId, input) {
      await requireMemberInTeam(memberId);
      const next: Limits = {
        budgetUsd: input.budgetUsd,
        period: input.period,
        tokenCap: input.tokenCap,
        rpm: input.rpm,
        tpm: input.tpm,
      };
      await control.setLimits(actor, memberId, next);
      return { message: "Limit updated.", secret: null, memberId };
    },

    async updateModels(memberId, modelIds) {
      await requireMemberInTeam(memberId);
      await control.setModels(actor, memberId, modelIds);
      return { message: "Models updated.", secret: null, memberId };
    },

    async keyAction(memberId, action, reason) {
      await requireMemberInTeam(memberId);
      if (action === "rotate") {
        const rotated = await control.rotateKey(actor, memberId);
        return {
          message: "Key rotated. The old key stops working immediately.",
          secret: rotated.secret,
          memberId,
        };
      }
      if (action === "block") {
        await control.blockKey(actor, memberId, reason ?? "Blocked by a manager.");
        return { message: "Key blocked.", secret: null, memberId };
      }
      await control.unblockKey(actor, memberId);
      return { message: "Key unblocked.", secret: null, memberId };
    },

    async saveRule(rule) {
      const id = rule.id === "" ? `rule_${randomSuffix()}` : rule.id;
      await control.upsertRule(actor, { ...rule, id });
      return { message: "Rule saved.", secret: null, memberId: null };
    },

    async savePolicy(policy: TeamPolicy) {
      await control.setTeamPolicy(actor, { ...policy, teamId, updatedAt: toIso(clock.now()) });
      return { message: "Team policy saved.", secret: null, memberId: null };
    },

    async createRequest(input) {
      const request = await control.createRequest({
        memberId: actor.memberId,
        teamId,
        kind: input.kind,
        amountUsd: input.amountUsd,
        modelId: input.modelId,
        message: input.message,
      });
      return { message: "Request sent to your manager.", secret: null, memberId: request.memberId };
    },

    async cancelRequest(requestId) {
      await control.cancelRequest(actor, requestId);
      return { message: "Request cancelled.", secret: null, memberId: actor.memberId };
    },

    async revokeGrant(memberId, grantId, reason) {
      await requireMemberInTeam(memberId);
      await control.revokeGrant(actor, grantId, reason);
      return {
        message: "Grant revoked. The key updates on the next reconcile.",
        secret: null,
        memberId,
      };
    },

    async enrolMember(input) {
      const created = await control.createMember(actor, teamId, {
        displayName: input.displayName,
        email: input.email,
        role: input.role,
        limits: {
          budgetUsd: input.budgetUsd,
          period: input.period,
          tokenCap: null,
          rpm: null,
          tpm: null,
        },
      });
      return {
        message: "Member enrolled. The key is shown once.",
        secret: created.secret,
        memberId: created.id,
      };
    },
  };

  const auth: ConsoleAuth = {
    async login(attempt) {
      const ip = attempt.ip;
      const limit = deps.limiter.check(ip);
      if (limit.limited) {
        return {
          ok: false,
          message: "Too many sign-in attempts. Try again in a few minutes.",
          cookie: null,
          viewer: null,
          status: 429,
        };
      }

      const memberKey = attempt.memberKey.trim();
      if (memberKey.length > 0) {
        const hash = sha256Hex(memberKey);
        const member = await deps.store.getMemberByKeyHash(hash);
        const valid =
          member !== null &&
          member.keyHash !== null &&
          safeEqual(member.keyHash, hash) &&
          member.role === "member";
        if (!valid) {
          deps.limiter.recordFailure(ip);
          return {
            ok: false,
            message: "That member key is not valid.",
            cookie: null,
            viewer: null,
          };
        }
        deps.limiter.clear(ip);
        return signedIn(member);
      }

      const email = attempt.email.trim();
      if (email === "" || attempt.password === "") {
        deps.limiter.recordFailure(ip);
        return {
          ok: false,
          message: "Enter your e-mail and password, or your member key.",
          cookie: null,
          viewer: null,
        };
      }
      const credential = await deps.credentials.findByEmail(email);
      if (credential === null) {
        // Same scrypt work as a real account, so the response time does not
        // reveal whether the account exists (SECURITY.md).
        await verifyPassword(attempt.password, DUMMY_PASSWORD_HASH);
        deps.limiter.recordFailure(ip);
        return {
          ok: false,
          message: "E-mail or password is incorrect.",
          cookie: null,
          viewer: null,
        };
      }
      const valid = await verifyPassword(attempt.password, credential.passwordHash);
      const member = valid ? await control.getMember(credential.memberId) : null;
      if (!valid || member === null || member.role === "member") {
        deps.limiter.recordFailure(ip);
        return {
          ok: false,
          message: "E-mail or password is incorrect.",
          cookie: null,
          viewer: null,
        };
      }
      deps.limiter.clear(ip);
      return signedIn(member);
    },

    logout() {
      return clearedCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: deps.cookieSecure,
        sameSite: "Strict",
        path: "/",
      });
    },
  };

  async function signedIn(member: Member): Promise<LoginResult> {
    const team = await control.getTeam(member.teamId);
    const session = deps.sessions.create({
      memberId: member.id,
      teamId: member.teamId,
      role: member.role,
      ttlMs: deps.sessionTtlMs,
    });
    return {
      ok: true,
      message: null,
      cookie: sessionCookie(session, deps),
      viewer: viewerOf(session, member, team?.name ?? "", deps.clock),
    };
  }

  return { data, actions, auth };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function sessionCookie(session: Session, deps: ConsoleWiringDeps): string {
  const value = signSessionCookie(session, deps.sessionSecret);
  const maxAge = Math.floor(deps.sessionTtlMs / 1000);
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${
    deps.cookieSecure ? "; Secure" : ""
  }`;
}

export function viewerOf(session: Session, member: Member, teamName: string, clock: Clock): Viewer {
  void clock;
  return {
    role: session.role,
    displayName: member.displayName,
    teamId: session.teamId,
    teamName,
    memberId: member.id,
    csrfToken: session.csrfToken,
    email: member.email,
  };
}

/** Resolve the console session from a cookie header; null when absent or stale. */
export function resolveConsoleSession(
  cookieHeader: string | undefined,
  deps: {
    sessions: SessionStore;
    sessionSecret: string;
    clock: Clock;
  },
): Session | null {
  if (cookieHeader === undefined) return null;
  const value = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (value === undefined) return null;
  const payload = verifySessionCookie(value, deps.sessionSecret, deps.clock.now().getTime());
  if (payload === null) return null;
  return deps.sessions.get(payload.id);
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) out[name] = value;
  }
  return out;
}
