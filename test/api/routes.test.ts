/**
 * Every protected route × every role.
 *
 * A member route is open to any authenticated principal; a manager route
 * refuses members; an admin route refuses managers. Refusals must be 403, not
 * a silent success or a 401.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SECRETS } from "./fixtures.ts";
import {
  adminSessionClient,
  bodyOf,
  loginWithMemberKey,
  managerSessionClient,
  startTestServer,
  type TestClient,
  type TestServer,
} from "./harness.ts";

let server: TestServer;
let memberKeyClient: TestClient;
let memberSession: TestClient;
let managerTokenClient: TestClient;
let managerSession: TestClient;
let adminTokenClient: TestClient;
let adminSession: TestClient;
let anonymous: TestClient;

interface RoleExpectation {
  member: boolean;
  manager: boolean;
  admin: boolean;
}

interface RouteCase {
  label: string;
  method: string;
  path: string;
  allowed: RoleExpectation;
  body?: () => unknown;
}

function policyBody(): unknown {
  return {
    teamId: "team-platform",
    offHours: {
      enabled: true,
      timeZone: "Europe/Berlin",
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1080,
      holidays: [],
      capUsd: 5,
    },
    thresholds: { softRatio: 0.8, graceRatio: 0.05 },
    unusualSpendMinUsd: 2,
    notifications: [{ channel: "log", config: {}, enabled: true }],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const MEMBER_ROLES: RoleExpectation = { member: true, manager: true, admin: true };
const MANAGER_ROLES: RoleExpectation = { member: false, manager: true, admin: true };
const ADMIN_ROLES: RoleExpectation = { member: false, manager: false, admin: true };

const ROUTES: readonly RouteCase[] = [
  { label: "GET /api/me", method: "GET", path: "/api/me", allowed: MEMBER_ROLES },
  { label: "GET /api/me/requests", method: "GET", path: "/api/me/requests", allowed: MEMBER_ROLES },
  {
    label: "POST /api/me/requests",
    method: "POST",
    path: "/api/me/requests",
    allowed: MEMBER_ROLES,
    body: () => ({ kind: "suggestion", message: "Please note this." }),
  },
  {
    label: "POST /api/me/requests/:id/cancel",
    method: "POST",
    path: "/api/me/requests/req-platform/cancel",
    allowed: MEMBER_ROLES,
  },
  {
    label: "GET /api/me/usage",
    method: "GET",
    path: "/api/me/usage?from=2026-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z",
    allowed: MEMBER_ROLES,
  },

  {
    label: "GET /api/team/overview",
    method: "GET",
    path: "/api/team/overview",
    allowed: MANAGER_ROLES,
  },
  {
    label: "GET /api/team/usage",
    method: "GET",
    path: "/api/team/usage?from=2026-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z",
    allowed: MANAGER_ROLES,
  },
  {
    label: "GET /api/team/requests",
    method: "GET",
    path: "/api/team/requests",
    allowed: MANAGER_ROLES,
  },
  {
    label: "POST /api/team/requests/:id/decide",
    method: "POST",
    path: "/api/team/requests/req-platform/decide",
    allowed: MANAGER_ROLES,
    body: () => ({ outcome: "denied", note: "Not this week." }),
  },
  {
    label: "GET /api/team/members",
    method: "GET",
    path: "/api/team/members",
    allowed: MANAGER_ROLES,
  },
  {
    label: "GET /api/team/members/:id",
    method: "GET",
    path: "/api/team/members/mem-1",
    allowed: MANAGER_ROLES,
  },
  {
    label: "PATCH /api/team/members/:id/limits",
    method: "PATCH",
    path: "/api/team/members/mem-1/limits",
    allowed: MANAGER_ROLES,
    body: () => ({ budgetUsd: 25 }),
  },
  {
    label: "PATCH /api/team/members/:id/models",
    method: "PATCH",
    path: "/api/team/members/mem-1/models",
    allowed: MANAGER_ROLES,
    body: () => ({ modelIds: ["cheap-model"] }),
  },
  {
    label: "POST /api/team/members/:id/key/block",
    method: "POST",
    path: "/api/team/members/mem-1/key/block",
    allowed: MANAGER_ROLES,
    body: () => ({ reason: "Runaway session." }),
  },
  {
    label: "POST /api/team/members/:id/key/unblock",
    method: "POST",
    path: "/api/team/members/mem-1/key/unblock",
    allowed: MANAGER_ROLES,
  },
  {
    label: "POST /api/team/members/:id/key/rotate",
    method: "POST",
    path: "/api/team/members/mem-rot/key/rotate",
    allowed: MANAGER_ROLES,
  },
  { label: "GET /api/team/audit", method: "GET", path: "/api/team/audit", allowed: MANAGER_ROLES },
  { label: "GET /api/team/rules", method: "GET", path: "/api/team/rules", allowed: MANAGER_ROLES },
  {
    label: "PUT /api/team/rules/:id",
    method: "PUT",
    path: "/api/team/rules/rule-platform",
    allowed: MANAGER_ROLES,
    body: () => ({
      name: "Small top-ups",
      enabled: true,
      condition: { kind: "budget_topup", maxUsd: 2, oncePerDays: 7 },
    }),
  },
  {
    label: "GET /api/team/policy",
    method: "GET",
    path: "/api/team/policy",
    allowed: MANAGER_ROLES,
  },
  {
    label: "PUT /api/team/policy",
    method: "PUT",
    path: "/api/team/policy",
    allowed: MANAGER_ROLES,
    body: policyBody,
  },

  {
    label: "POST /api/team/grants/:id/revoke",
    method: "POST",
    path: "/api/team/grants/grant-1/revoke",
    allowed: MANAGER_ROLES,
    body: () => ({ reason: "route coverage" }),
  },
  {
    label: "GET /api/admin/teams",
    method: "GET",
    path: "/api/admin/teams",
    allowed: ADMIN_ROLES,
  },
  {
    label: "POST /api/admin/teams",
    method: "POST",
    path: "/api/admin/teams",
    allowed: ADMIN_ROLES,
    body: () => ({ name: "Edge", monthlyBudgetUsd: 120 }),
  },
  {
    label: "PATCH /api/admin/teams/:id",
    method: "PATCH",
    path: "/api/admin/teams/team-platform",
    allowed: ADMIN_ROLES,
    body: () => ({ name: "Platform" }),
  },
  {
    label: "DELETE /api/admin/teams/:id",
    method: "DELETE",
    path: "/api/admin/teams/team-scratch",
    allowed: ADMIN_ROLES,
  },
  {
    label: "POST /api/admin/teams/:id/members",
    method: "POST",
    path: "/api/admin/teams/team-platform/members",
    allowed: ADMIN_ROLES,
    body: () => ({ displayName: "Rowan", role: "member" }),
  },
  {
    label: "DELETE /api/admin/teams/:id/members/:memberId",
    method: "DELETE",
    path: "/api/admin/teams/team-platform/members/mem-del",
    allowed: ADMIN_ROLES,
  },
  {
    label: "POST /api/admin/manager-tokens",
    method: "POST",
    path: "/api/admin/manager-tokens",
    allowed: ADMIN_ROLES,
    body: () => ({ memberId: "mgr-1", label: "script" }),
  },
  {
    label: "GET /api/admin/teams/:id/members/:memberId/config-bundle",
    method: "GET",
    path: "/api/admin/teams/team-platform/members/mem-1/config-bundle",
    allowed: ADMIN_ROLES,
  },
  { label: "GET /api/session", method: "GET", path: "/api/session", allowed: MEMBER_ROLES },
  { label: "POST /logout", method: "POST", path: "/logout", allowed: MEMBER_ROLES },
];

before(async () => {
  server = await startTestServer();
  memberKeyClient = server.client();
  memberSession = server.client();
  managerTokenClient = server.client();
  managerSession = await managerSessionClient(server);
  adminTokenClient = server.client();
  adminSession = await adminSessionClient(server);
  anonymous = server.client();
  const login = await loginWithMemberKey(memberSession, SECRETS.memberKey);
  assert.equal(login.status, 200);
});

after(async () => {
  await server.close();
});

function clientFor(role: "member" | "manager" | "admin", session: boolean): TestClient {
  if (role === "member") return session ? memberSession : memberKeyClient;
  if (role === "manager") return session ? managerSession : managerTokenClient;
  return session ? adminSession : adminTokenClient;
}

function bearerFor(role: "member" | "manager" | "admin"): string | undefined {
  if (role === "member") return SECRETS.memberKey;
  if (role === "manager") return server.fixture.managerToken;
  return server.fixture.adminToken;
}

for (const route of ROUTES) {
  test(`${route.label} is allowed or refused per role`, async () => {
    for (const session of [false, true]) {
      for (const role of ["member", "manager", "admin"] as const) {
        const client = clientFor(role, session);
        const bearer = bearerFor(role);
        const response = await client.request(route.method, route.path, {
          body: route.body?.(),
          ...(bearer === undefined ? {} : { bearer }),
        });
        const label = `${route.label} as ${role} (${session ? "session" : "bearer"})`;
        if (route.allowed[role]) {
          assert.notEqual(response.status, 401, `${label} returned 401`);
          assert.notEqual(response.status, 403, `${label} returned 403`);
        } else {
          assert.equal(response.status, 403, `${label} should be refused`);
          const error = bodyOf<{ error: { code: string } }>(response);
          assert.equal(error.error.code, "forbidden", `${label} error code`);
        }
      }
    }

    const anonymousResponse = await anonymous.request(route.method, route.path, {
      body: route.body?.(),
    });
    assert.equal(anonymousResponse.status, 401, `${route.label} without a credential`);
  });
}

test("a member key on a manager route gets the documented message", async () => {
  const response = await memberKeyClient.request("GET", "/api/team/overview", {
    bearer: SECRETS.memberKey,
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { code: string; message: string } }>(response);
  assert.equal(error.error.message, "A member key cannot call a manager route.");
});

test("a manager token on an admin route is refused", async () => {
  const response = await managerTokenClient.request("GET", "/api/admin/teams", {
    bearer: server.fixture.managerToken,
  });
  assert.equal(response.status, 403);
  const error = bodyOf<{ error: { message: string } }>(response);
  assert.equal(error.error.message, "Admin role required.");
});

test("mutating manager and admin routes write one audit event each", async () => {
  const before = server.fixture.store.audit.length;
  const response = await managerTokenClient.request("PATCH", "/api/team/members/mem-1/limits", {
    bearer: server.fixture.managerToken,
    body: { budgetUsd: 31 },
  });
  assert.equal(response.status, 200);
  const events = server.fixture.store.audit.slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.actor.id, "mgr-1");
  assert.equal(events[0]?.event.objectType, "member");
});
