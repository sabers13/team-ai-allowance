/**
 * A real store, control service and console over a fake gateway.
 *
 * These tests exercise the adapters `taa serve` wires together; the API tests
 * use a hand-written `ControlPort`, which is exactly why the console team check
 * went unnoticed.
 */

import type { Actor } from "../../src/api/index.ts";
import {
  type CredentialStore,
  createLoginRateLimiter,
  createMemoryCredentialStore,
  createMemorySessionStore,
  hashPassword,
  type LoginRateLimiter,
  type SessionStore,
} from "../../src/auth/index.ts";
import { type Console, createConsole, type Viewer } from "../../src/console/index.ts";
import type { Notifier, Team } from "../../src/contracts.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { ControlService } from "../../src/core/service.ts";
import { createConsolePorts } from "../../src/server/console.ts";
import { type ControlPortWithKeys, createControlPort } from "../../src/server/control.ts";
import { openSqliteStore, type SqliteStore } from "../../src/store/index.ts";
import { FakeGateway } from "../core/fakes.ts";

export const SESSION_SECRET = "test-session-secret-0123456789abcdef";
export const CSRF = "csrf-token-for-tests";

export interface ServerFixture {
  store: SqliteStore;
  gateway: FakeGateway;
  clock: ManualClock;
  service: ControlService;
  control: ControlPortWithKeys;
  credentials: CredentialStore;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  consoleFor(viewer: Viewer | null): Console;
  admin: Actor;
  close(): void;
}

export interface SeededServer extends ServerFixture {
  teamA: Team;
  teamB: Team;
  managerA: Actor;
  managerB: Actor;
  memberA: { id: string; secret: string; keyAlias: string };
  memberB: { id: string; secret: string; keyAlias: string };
  managerEmail: string;
  managerPassword: string;
}

function actorFor(
  member: { id: string; teamId: string; role: Actor["role"] },
  role: Actor["role"],
): Actor {
  return { memberId: member.id, teamId: member.teamId, role, via: "session" };
}

export async function makeServerFixture(
  options: { notifier?: Notifier } = {},
): Promise<ServerFixture> {
  const clock = new ManualClock("2026-10-05T09:00:00Z");
  const store = openSqliteStore({ path: ":memory:", clock });
  const gateway = new FakeGateway();
  const ids = sequentialIds();
  const service = new ControlService({
    store,
    gateway,
    clock,
    ids,
    ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
  });
  const control = createControlPort({
    store,
    gateway,
    service,
    clock,
    ids,
    controlUrl: "http://control.test",
    gatewayUrl: "http://gateway.test",
  });
  const credentials = createMemoryCredentialStore(clock);
  const sessions = createMemorySessionStore(clock);
  const limiter = createLoginRateLimiter({ maxAttempts: 3, windowMs: 15 * 60 * 1000, clock });

  function consoleFor(viewer: Viewer | null): Console {
    const ports = createConsolePorts(
      {
        control,
        store,
        gateway,
        clock,
        credentials,
        sessions,
        limiter,
        sessionSecret: SESSION_SECRET,
        cookieSecure: false,
        sessionTtlMs: 12 * 60 * 60 * 1000,
        controlUrl: "http://control.test",
        gatewayUrl: "http://gateway.test",
        hints: [],
        timeZone: "UTC",
      },
      viewer,
    );
    return createConsole({
      data: ports.data,
      actions: ports.actions,
      auth: ports.auth,
      now: () => clock.now(),
      timeZone: "UTC",
    });
  }

  return {
    store,
    gateway,
    clock,
    service,
    control,
    credentials,
    sessions,
    limiter,
    consoleFor,
    admin: { memberId: "admin_seed", teamId: "", role: "admin", via: "session" },
    close: () => store.close(),
  };
}

export async function seedTwoTeams(options: { notifier?: Notifier } = {}): Promise<SeededServer> {
  const base = await makeServerFixture(options);
  const { control, admin } = base;
  for (const [id, displayName] of [
    ["mock-cheap", "Mock Cheap"],
    ["mock-flagship", "Mock Flagship"],
  ] as const) {
    await base.store.upsertModel({
      id,
      displayName,
      route: `mock/${id}`,
      inputPer1MUsd: 0.5,
      outputPer1MUsd: 1.5,
      state: "enabled",
      sortOrder: 1,
    });
  }
  const teamA = await control.createTeam(admin, { name: "Platform", monthlyBudgetUsd: 100 });
  const teamB = await control.createTeam(admin, { name: "Data", monthlyBudgetUsd: 50 });

  const managerEmail = "manager@example.test";
  const managerPassword = "a-long-manager-password";
  const managerLimits = {
    budgetUsd: 20,
    period: "monthly" as const,
    tokenCap: null,
    rpm: null,
    tpm: null,
  };
  const manager = await control.createMember(admin, teamA.id, {
    displayName: "Mara",
    email: managerEmail,
    role: "manager",
    limits: managerLimits,
  });
  const managerB = await control.createMember(admin, teamB.id, {
    displayName: "Noor",
    email: "noor@example.test",
    role: "manager",
    limits: managerLimits,
  });
  const memberA = await control.createMember(admin, teamA.id, {
    displayName: "Lena",
    email: null,
    role: "member",
    limits: managerLimits,
  });
  const memberB = await control.createMember(admin, teamB.id, {
    displayName: "Omar",
    email: null,
    role: "member",
    limits: managerLimits,
  });
  await base.credentials.setPassword(manager.id, managerEmail, await hashPassword(managerPassword));

  return {
    ...base,
    teamA,
    teamB,
    managerA: actorFor(manager, "manager"),
    managerB: actorFor(managerB, "manager"),
    memberA: { id: memberA.id, secret: memberA.secret, keyAlias: memberA.keyAlias },
    memberB: { id: memberB.id, secret: memberB.secret, keyAlias: memberB.keyAlias },
    managerEmail,
    managerPassword,
  };
}
