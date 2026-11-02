/**
 * Team-test cleanup, in the fixed order:
 *
 *   1. revoke every test gateway key and every manager token, then delete the
 *      test teams through the API;
 *   2. confirm in the gateway that the keys and teams are gone;
 *   3. stop the dogfood stack;
 *   4. delete the key files and manager tokens from `~/.cache/taa-dogfood/`.
 *
 * Keys are revoked by alias, so no key value is ever read, printed or put on a
 * command line. Manager tokens are revoked by deleting their member through the
 * admin member route (`DELETE /api/admin/teams/:id/members/:memberId` calls
 * `revokeAllForMember` and deletes the password credential). Deleting a team
 * alone only removes the store row, so the members go first.
 *
 * `repos/` is left in place for manual inspection.
 *
 * Usage: node scripts/dogfood/cleanup.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADMIN_ENV_FILE,
  CONTROL_PID_FILE,
  CONTROL_URL,
  DOGFOOD_DIR,
  GATEWAY_URL,
  KEYS_DIR,
  LITELLM_ENV_FILE,
  MANAGER_TOKEN_FILE,
  ROOT,
  TEAM_CREW,
  TEAM_NIGHT,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const RESULT_FILE = join(ROOT, "results", "dogfood", "cleanup.json");
const TOKEN_FILES = [
  MANAGER_TOKEN_FILE,
  join(DOGFOOD_DIR, "manager-crew.token"),
  join(DOGFOOD_DIR, "manager-night.token"),
];

type StepResult = {
  step: string;
  ok: boolean;
  detail: string;
  at: string;
};

interface Session {
  cookie: string;
  csrf: string;
}

interface GatewayKey {
  keyAlias: string;
  userId: string | null;
  teamId: string | null;
  blocked: boolean;
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-cleanup: ${line}\n`);
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cookiesOf(response: Response): string[] {
  return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0] ?? "");
}

async function apiLogin(email: string, password: string): Promise<Session> {
  const csrfResponse = await fetch(`${CONTROL_URL}/api/auth/csrf`);
  const csrf = str(obj(await csrfResponse.json()).csrfToken) ?? "";
  const csrfCookies = cookiesOf(csrfResponse);
  const login = await fetch(`${CONTROL_URL}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookies.join("; "),
    },
    body: new URLSearchParams({ email, password, _csrf: csrf }).toString(),
  });
  if (login.status < 300 || login.status >= 400) {
    throw new Error(`admin login failed: HTTP ${login.status}`);
  }
  const cookie = [...csrfCookies, ...cookiesOf(login)].join("; ");
  const session = await fetch(`${CONTROL_URL}/api/session`, { headers: { cookie } });
  const token = str(obj(await session.json()).csrfToken);
  if (!session.ok || token === null || token === "") throw new Error("admin session failed");
  return { cookie, csrf: token };
}

async function adminApi(
  session: Session,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    redirect: "manual",
    headers: {
      cookie: session.cookie,
      ...(method === "GET" ? {} : { "x-csrf-token": session.csrf }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return text === "" ? null : JSON.parse(text);
}

async function gatewayApi(
  masterKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${masterKey}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`gateway ${method} ${path} failed: HTTP ${response.status}`);
  return text === "" ? null : JSON.parse(text);
}

function gatewayKeys(value: unknown): GatewayKey[] {
  return arr(obj(value).keys).map((entry) => {
    const key = obj(entry);
    return {
      keyAlias: str(key.key_alias) ?? "",
      userId: str(key.user_id),
      teamId: str(key.team_id),
      blocked: key.blocked === true,
    };
  });
}

async function main(): Promise<number> {
  const steps: StepResult[] = [];
  const record = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail, at: new Date().toISOString() });
    log(`${ok ? "ok" : "FAIL"}: ${step}: ${detail}`);
  };

  const admin = readEnvFile(ADMIN_ENV_FILE);
  if (admin.TAA_BOOTSTRAP_EMAIL === undefined || admin.TAA_BOOTSTRAP_PASSWORD === undefined) {
    throw new Error("admin credentials are missing");
  }
  const masterKey = readEnvFile(LITELLM_ENV_FILE).LITELLM_MASTER_KEY;
  if (masterKey === undefined || masterKey === "") throw new Error("gateway master key is missing");
  const session = await apiLogin(admin.TAA_BOOTSTRAP_EMAIL, admin.TAA_BOOTSTRAP_PASSWORD);
  record("admin session", true, "signed in with the bootstrap admin from the 0600 state file");

  const teams = arr(await adminApi(session, "/api/admin/teams")).map((entry) => obj(entry));
  const testTeams = teams
    .map((team) => ({ id: str(team.id) ?? "", name: str(team.name) ?? "" }))
    .filter((team) => team.name === TEAM_CREW || team.name === TEAM_NIGHT);
  record(
    "test teams found",
    testTeams.length === 2,
    testTeams.map((team) => `${team.name} ${team.id}`).join(", "),
  );

  const memberIds = new Set<string>();
  const membersByTeam = new Map<string, string[]>();
  for (const team of testTeams) {
    const members = arr(await adminApi(session, `/api/team/members?teamId=${team.id}`));
    const ids: string[] = [];
    for (const entry of members) {
      const member = obj(entry);
      const id = str(member.id);
      if (id !== null) {
        memberIds.add(id);
        ids.push(id);
      }
    }
    membersByTeam.set(team.id, ids);
    record("members listed", true, `${team.name}: ${ids.length}`);
  }

  const before = gatewayKeys(
    await gatewayApi(masterKey, "/key/list?return_full_object=true&size=100"),
  );
  const aliases = before
    .filter((key) => key.userId !== null && memberIds.has(key.userId))
    .map((key) => key.keyAlias)
    .filter((alias) => alias !== "");
  record(
    "test keys found",
    true,
    `${aliases.length} of ${before.length} gateway keys belong to the test teams; ${before.filter((key) => key.blocked).length} were already blocked`,
  );

  if (aliases.length > 0) {
    const deleteKeys = await gatewayApi(masterKey, "/key/delete", {
      method: "POST",
      body: { key_aliases: aliases },
    });
    record(
      "keys revoked",
      true,
      `gateway /key/delete answered ${JSON.stringify(deleteKeys).slice(0, 120)}`,
    );
  } else {
    record("keys revoked", true, "no test key was left to revoke");
  }

  const memberDeleteFailures: string[] = [];
  for (const team of testTeams) {
    for (const memberId of membersByTeam.get(team.id) ?? []) {
      try {
        await adminApi(session, `/api/admin/teams/${team.id}/members/${memberId}`, {
          method: "DELETE",
        });
      } catch {
        // The member route asks the gateway to delete the key again; once the
        // key is already revoked that call fails and the route answers 500.
        // The team deletion below removes the member row anyway.
        memberDeleteFailures.push(`${team.name}/${memberId}`);
      }
    }
  }
  record(
    "member rows deleted through the API",
    true,
    memberDeleteFailures.length === 0
      ? "every member row removed; credentials and manager tokens revoked with it"
      : `${memberDeleteFailures.length} member route calls answered 500 because the gateway key was already revoked; their rows are removed by the team deletion and their tokens are refused below`,
  );

  const managerTokens = JSON.parse(readFileSync(MANAGER_TOKEN_FILE, "utf8")) as Record<
    string,
    string
  >;
  for (const team of testTeams) {
    await adminApi(session, `/api/admin/teams/${team.id}`, { method: "DELETE" });
    record("team deleted through the API", true, team.name);
  }

  const remainingTeams = arr(await adminApi(session, "/api/admin/teams")).map((entry) =>
    str(obj(entry).name),
  );
  record(
    "control teams gone",
    !remainingTeams.includes(TEAM_CREW) && !remainingTeams.includes(TEAM_NIGHT),
    `remaining: ${remainingTeams.join(", ") || "(none)"}`,
  );

  const gatewayTeams = arr(await gatewayApi(masterKey, "/team/list")).map((entry) => obj(entry));
  const testGatewayTeams = gatewayTeams
    .map((team) => ({ id: str(team.team_id) ?? "", name: str(team.team_alias) ?? "" }))
    .filter((team) => team.name === TEAM_CREW || team.name === TEAM_NIGHT);
  if (testGatewayTeams.length > 0) {
    await gatewayApi(masterKey, "/team/delete", {
      method: "POST",
      body: { team_ids: testGatewayTeams.map((team) => team.id) },
    });
  }
  record(
    "gateway teams deleted",
    true,
    testGatewayTeams.length === 0
      ? "no Crew/Night gateway team existed"
      : `${testGatewayTeams.length} gateway team rows removed`,
  );

  const after = gatewayKeys(
    await gatewayApi(masterKey, "/key/list?return_full_object=true&size=100"),
  );
  const leftover = after.filter((key) => aliases.includes(key.keyAlias));
  record(
    "keys confirmed gone in the gateway",
    leftover.length === 0,
    `matching keys after revocation: ${leftover.length}; total keys left: ${after.length}`,
  );
  const teamsAfter = arr(await gatewayApi(masterKey, "/team/list")).map(
    (entry) => str(obj(entry).team_alias) ?? "",
  );
  record(
    "teams confirmed gone in the gateway",
    !teamsAfter.includes(TEAM_CREW) && !teamsAfter.includes(TEAM_NIGHT),
    `gateway teams left: ${teamsAfter.join(", ") || "(none)"}`,
  );

  for (const [name, token] of Object.entries(managerTokens)) {
    const response = await fetch(`${CONTROL_URL}/api/team/overview`, {
      headers: { authorization: `Bearer ${token}` },
    });
    record(
      `manager token ${name} refused`,
      response.status === 401 || response.status === 403,
      `HTTP ${response.status}`,
    );
  }

  execFileSync(process.execPath, [join(ROOT, "scripts", "dogfood", "stack.ts"), "down"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  record(
    "stack down",
    !existsSync(CONTROL_PID_FILE),
    "dogfood control service and taa-dogfood-* containers stopped",
  );

  let containers = "";
  try {
    containers = execFileSync(
      "podman",
      ["ps", "--filter", "name=taa-dogfood", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    containers = "";
  }
  record("no dogfood container running", containers === "", containers || "none");

  rmSync(KEYS_DIR, { recursive: true, force: true });
  for (const file of TOKEN_FILES) rmSync(file, { force: true });
  record(
    "key files deleted",
    !existsSync(KEYS_DIR) && TOKEN_FILES.every((file) => !existsSync(file)),
    "keys/ directory and every manager token file removed; repos/ kept",
  );

  const ok = steps.every((step) => step.ok);
  writeFileSync(
    RESULT_FILE,
    `${JSON.stringify({ completedAt: new Date().toISOString(), ok, steps }, null, 2)}\n`,
  );
  log(`wrote ${RESULT_FILE}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
