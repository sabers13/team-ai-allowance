/**
 * Team-test setup: teams, members, rules, scratch repositories.
 *
 * Everything is created through the running stack's own HTTP API, with two
 * documented exceptions:
 *
 *  - the model catalogue has no write route (the console page is read-only),
 *    so `stack.ts` seeds it into SQLite before the control service starts;
 *  - the auto-approve rule is created through the console form that a manager
 *    uses, because `PUT /api/team/rules/:id` only edits an existing rule and
 *    the product has no JSON create route.
 *
 * Keys are written once, straight to `~/.cache/taa-dogfood/keys/<member>.key`
 * with mode 0600, and never printed. Manager tokens go to `manager.token`
 * (mode 0600) as `{"crew": "...", "night": "..."}`, because a manager identity
 * belongs to one team and the team test needs a leader for both.
 *
 * Run after `node scripts/dogfood/stack.ts up`:
 *
 *   node scripts/dogfood/setup.ts
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OpenCodeConfig, openCodeConfig, type SetupSpec } from "../../src/setup/index.ts";
import { isWorkingTime } from "../../src/watcher/index.ts";
import {
  ADMIN_ENV_FILE,
  BLOCKED_MODEL,
  CONTROL_URL,
  DOGFOOD_DIR,
  FLAGSHIP,
  GATEWAY_URL,
  KEYS_DIR,
  keyPath,
  MAIL_TO,
  MANAGER_NAME,
  MANAGER_TOKEN_FILE,
  MEMBERS,
  MEMBERS_FILE,
  type MemberSpec,
  MODEL,
  mainCheckout,
  PLUGIN_PATH,
  PROVIDER_ID,
  README_FILE,
  REPO_MEMBERS,
  repoPath,
  TEAM_CREW,
  TEAM_NIGHT,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const RULE_NAME = "Auto-approve USD 0.01 once per day";

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-setup: ${line}\n`);
}

interface Session {
  cookie: string[];
  csrf: string;
}

interface ApiResult {
  status: number;
  body: unknown;
}

async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${CONTROL_URL}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
  });
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`login for ${email} failed: HTTP ${response.status}`);
  }
  const cookie = (response.headers.getSetCookie?.() ?? []).map(
    (entry) => entry.split(";")[0] ?? "",
  );
  const session = await fetch(`${CONTROL_URL}/api/session`, {
    headers: { cookie: cookie.join("; ") },
  });
  const body = (await session.json()) as { csrfToken?: string };
  if (session.status !== 200 || body.csrfToken === undefined || body.csrfToken === "") {
    throw new Error(`session for ${email} failed: HTTP ${session.status}`);
  }
  return { cookie, csrf: body.csrfToken };
}

/** A JSON API call authenticated by a browser session. */
async function api(session: Session, path: string, init: RequestInit = {}): Promise<ApiResult> {
  const mutating = (init.method ?? "GET") !== "GET";
  const response = await fetch(`${CONTROL_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      ...(init.headers ?? {}),
      cookie: session.cookie.join("; "),
      ...(mutating ? { "x-csrf-token": session.csrf } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function mustApi(
  session: Session,
  path: string,
  init: RequestInit,
  what: string,
): Promise<unknown> {
  const result = await api(session, path, init);
  if (result.status < 200 || result.status >= 300) {
    const text = JSON.stringify(result.body).slice(0, 300);
    throw new Error(`${what} failed: HTTP ${result.status} ${text}`);
  }
  return result.body;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

function randomPassword(): string {
  return randomBytes(16).toString("base64url");
}

interface TeamPolicyBody {
  offHours: {
    enabled: boolean;
    timeZone: string;
    workingDays: number[];
    startMinute: number;
    endMinute: number;
    holidays: string[];
    capUsd: number;
  };
  thresholds: { softRatio: number; graceRatio: number };
  unusualSpendMinUsd: number;
  notifications: Array<{ channel: string; config: Record<string, string>; enabled: boolean }>;
}

/** ISO weekday (1 = Monday … 7 = Sunday) in the team's zone. */
function isoWeekday(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name) + 1;
}

function policyFor(team: string, now: Date): TeamPolicyBody {
  const timeZone = "Europe/Berlin";
  // Crew: every day, all day, so the test time is inside working hours.
  // Night: every day except today, so the test time is outside them.
  const weekday = isoWeekday(now, timeZone);
  const workingDays =
    team === TEAM_CREW
      ? [1, 2, 3, 4, 5, 6, 7]
      : [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== weekday);
  return {
    offHours: {
      enabled: true,
      timeZone,
      workingDays,
      startMinute: 0,
      endMinute: 1439,
      holidays: [],
      capUsd: team === TEAM_NIGHT ? 0.01 : 5,
    },
    thresholds: { softRatio: 0.5, graceRatio: 0.3 },
    unusualSpendMinUsd: 0.01,
    notifications: [
      { channel: "log", config: {}, enabled: true },
      {
        channel: "webhook",
        config: { urlEnv: "TAA_GENERIC_WEBHOOK" },
        enabled: true,
      },
      {
        channel: "email",
        config: { to: MAIL_TO, from: "team-ai-allowance@example.test" },
        enabled: true,
      },
    ],
  };
}

function writeKey(memberId: string, secret: string): void {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath(memberId), `${secret}\n`, { mode: 0o600 });
}

function memberLimits(spec: MemberSpec): Record<string, unknown> {
  return {
    budgetUsd: spec.budgetUsd,
    period: spec.period,
    tokenCap: spec.tokenCap,
    rpm: null,
    tpm: null,
  };
}

const TASKS: Record<string, { title: string; task: string }> = {
  m1: {
    title: "unitconv: temperature and length conversions",
    task: "Build a small Python package `unitconv` with temperature and length conversions, pytest tests and a README section.",
  },
  m2: {
    title: "word-frequency CLI",
    task: "Build a word-frequency CLI with pytest tests.",
  },
  m3: {
    title: "fix the failing test",
    task: "Make the project's tests pass. The single test fails on purpose; the failing command trips the in-session loop rule after three identical attempts.",
  },
  m4: {
    title: "add docstrings to a small module",
    task: "Create the small module first (six small functions), then add a docstring to every function.",
  },
};

function readmeFor(spec: MemberSpec): string {
  const task = TASKS[spec.id];
  if (task === undefined) throw new Error(`no task text for ${spec.id}`);
  return `# dogfood-${spec.id}

Scratch repository for the team test. Every model call made
here goes through the team allowance gateway; the member is \`${spec.id}\` on
team \`${spec.team}\`.

## Task

${task.task}

## Model access

\`opencode.json\` points the \`${PROVIDER_ID}\` provider at the local gateway and
uses the model \`${PROVIDER_ID}/${MODEL}\`. It holds no key: the gateway key is
read from the member's own file (mode 0600) through a \`{file:...}\` reference.
The \`taa\` MCP desk is registered for this project, and the allowance plugin in
\`.opencode/plugins/\` enforces the in-session rules.

## Limits

The member's limits are tiny on purpose. Call the MCP tool \`my_allowance\`
before starting and after every five steps.
`;
}

function gitignoreFor(): string {
  return [
    "__pycache__/",
    "*.pyc",
    ".pytest_cache/",
    ".venv/",
    "node_modules/",
    ".env",
    "*.log",
    "",
  ].join("\n");
}

function writeRepo(spec: MemberSpec): string {
  const repo = repoPath(spec.id);
  mkdirSync(join(repo, ".opencode", "plugins"), { recursive: true });
  const main = mainCheckout();
  const setupSpec: SetupSpec = {
    team: {
      name: spec.team,
      gatewayUrl: GATEWAY_URL,
      providerId: PROVIDER_ID,
      defaultModel: MODEL,
      models: [
        { id: MODEL, displayName: "DeepSeek V4.1 Flash" },
        { id: FLAGSHIP, displayName: "Flagship (same upstream)" },
        { id: BLOCKED_MODEL, displayName: "Blocked model" },
      ],
      controlUrl: CONTROL_URL,
      mcp: {
        command: process.execPath,
        args: [join(main, "src", "cli", "index.ts"), "mcp", "--role", "member"],
      },
      // OpenCode 2 loads a plugin from a directory; the built plugin file is copied in.
      pluginPath: join(repo, ".opencode", "plugins"),
      security: {},
    },
    member: { id: spec.id, displayName: spec.displayName, email: null },
  };

  const config: OpenCodeConfig & { agent: { title: { disable: boolean } } } = {
    ...openCodeConfig(setupSpec),
    // OpenCode writes a session title with a second, uncapped model call. The
    // gateway projects that call's full output window against the tiny member
    // budget and refuses it, which kills the session before its first turn.
    agent: { title: { disable: true } },
  };
  const provider = config.provider[PROVIDER_ID];
  if (provider === undefined) throw new Error("generated config has no allowance provider");
  // Cap the model's output. OpenCode then sends `max_completion_tokens`, and
  // LiteLLM's budget check stops projecting the model's full output window
  // (about USD 0.05 of test-denominated output) against a USD 0.02 budget.
  for (const model of Object.values(provider.models) as Array<{
    name: string;
    limit?: { context: number; output: number };
  }>) {
    model.limit = { context: 128_000, output: 2_000 };
  }
  // The member key is a file reference, so no environment variable has to be
  // exported before a worker starts.
  provider.options.apiKey = `{file:${keyPath(spec.id)}}`;
  const mcp = config.mcp.taa;
  if (mcp === undefined) throw new Error("generated config has no taa MCP server");
  mcp.environment = {
    TAA_BASE_URL: CONTROL_URL,
    TAA_KEY_FILE: keyPath(spec.id),
  };
  writeFileSync(join(repo, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  copyFileSync(PLUGIN_PATH, join(repo, ".opencode", "plugins", "team-ai-allowance.ts"));
  writeFileSync(join(repo, "README.md"), readmeFor(spec));
  writeFileSync(join(repo, ".gitignore"), gitignoreFor());

  if (spec.id === "m3") {
    writeFileSync(
      join(repo, "calc.py"),
      [
        '"""Tiny arithmetic module used by the team test."""',
        "",
        "",
        "def add(a: int, b: int) -> int:",
        "    return a + b",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "test_calc.py"),
      [
        "from calc import add",
        "",
        "",
        "def test_add() -> None:",
        "    assert add(2, 2) == 5",
        "",
      ].join("\n"),
    );
  }

  if (!existsSync(join(repo, ".git"))) {
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  }
  execFileSync("git", ["-C", repo, "config", "user.name", "TAA dogfood"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "dogfood@example.test"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "commit",
    "-q",
    "-m",
    `Scratch repository for member ${spec.id}`,
  ]);
  return repo;
}

async function main(): Promise<number> {
  const state = readEnvFile(ADMIN_ENV_FILE);
  const email = state.TAA_BOOTSTRAP_EMAIL;
  const password = state.TAA_BOOTSTRAP_PASSWORD;
  if (email === undefined || password === undefined) {
    throw new Error("run `node scripts/dogfood/stack.ts up` first (admin credentials are missing)");
  }

  if (process.argv.includes("--repos-only")) {
    const repos = JSON.parse(readFileSync(MEMBERS_FILE, "utf8")) as Record<string, string>;
    for (const id of REPO_MEMBERS) {
      const spec = MEMBERS.find((member) => member.id === id);
      if (spec === undefined) throw new Error(`no member spec for ${id}`);
      writeRepo(spec);
      log(`repo ${repoPath(id)} regenerated -> ${repos[`dogfood-${id}`] ?? "?"}`);
    }
    return 0;
  }

  const admin = await login(email, password);
  log("admin session ready");

  const existing = (await mustApi(admin, "/api/admin/teams", {}, "team list")) as Array<{
    id: string;
    name: string;
  }>;
  for (const name of [TEAM_CREW, TEAM_NIGHT]) {
    if (existing.some((team) => team.name === name)) {
      throw new Error(
        `team ${name} already exists: this database is already provisioned. ` +
          "Run `node scripts/dogfood/stack.ts down --purge` and start again for a fresh test.",
      );
    }
  }

  const now = new Date();
  const teams: Record<string, string> = {};
  for (const name of [TEAM_CREW, TEAM_NIGHT]) {
    const created = (await mustApi(
      admin,
      "/api/admin/teams",
      jsonBody({ name, monthlyBudgetUsd: 1 }),
      `team ${name}`,
    )) as { id: string };
    teams[name] = created.id;
    log(`team ${name}: ${created.id}`);
    const policy = policyFor(name, now);
    await mustApi(
      admin,
      `/api/team/policy?teamId=${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      },
      `policy for ${name}`,
    );
    const stored = (await mustApi(
      admin,
      `/api/team/policy?teamId=${created.id}`,
      {},
      `policy read for ${name}`,
    )) as TeamPolicyBody;
    const working = isWorkingTime(now, stored.offHours);
    const expected = name === TEAM_CREW;
    if (working !== expected) {
      throw new Error(
        `${name} working hours are wrong for this test time (expected ${expected}, got ${working})`,
      );
    }
    log(
      `team ${name}: soft ${stored.thresholds.softRatio}, grace ${stored.thresholds.graceRatio}, ` +
        `unusual USD ${stored.unusualSpendMinUsd.toFixed(2)}, off-hours cap USD ${stored.offHours.capUsd.toFixed(2)}, ` +
        `working now: ${working}`,
    );
  }

  const memberIds: Record<string, string> = {};
  for (const spec of MEMBERS) {
    const teamId = teams[spec.team];
    if (teamId === undefined) throw new Error(`team ${spec.team} was not created`);
    const created = (await mustApi(
      admin,
      `/api/admin/teams/${teamId}/members`,
      jsonBody({
        displayName: spec.displayName,
        role: "member",
        limits: memberLimits(spec),
      }),
      `member ${spec.id}`,
    )) as { member: { id: string }; secret: string };
    memberIds[spec.id] = created.member.id;
    writeKey(spec.id, created.secret);
    log(`member ${spec.id} (${spec.displayName}, ${spec.team}): ${created.member.id}`);
  }

  // One Leader identity per team: a manager belongs to exactly one team, and
  // the leader has to decide requests for both Crew and Night.
  const managerTokens: Record<string, string> = {};
  const leaderPasswords: Record<string, string> = {};
  for (const name of [TEAM_CREW, TEAM_NIGHT]) {
    const teamId = teams[name];
    if (teamId === undefined) throw new Error(`team ${name} was not created`);
    const password = randomPassword();
    leaderPasswords[name] = password;
    const created = (await mustApi(
      admin,
      `/api/admin/teams/${teamId}/members`,
      jsonBody({
        displayName: MANAGER_NAME,
        role: "manager",
        email: `leader-${name.toLowerCase()}@example.test`,
        password,
      }),
      `manager for ${name}`,
    )) as { member: { id: string } };
    const token = (await mustApi(
      admin,
      "/api/admin/manager-tokens",
      jsonBody({ memberId: created.member.id, label: `dogfood ${name.toLowerCase()} leader` }),
      `manager token for ${name}`,
    )) as { token: string };
    managerTokens[name === TEAM_CREW ? "crew" : "night"] = token.token;
    log(`manager ${MANAGER_NAME} for ${name}: ${created.member.id} (token issued)`);
  }
  writeFileSync(MANAGER_TOKEN_FILE, `${JSON.stringify(managerTokens, null, 2)}\n`, { mode: 0o600 });
  // Raw copies for callers that expect one bearer token in one file.
  for (const [team, token] of Object.entries(managerTokens)) {
    writeFileSync(join(DOGFOOD_DIR, `manager-${team}.token`), `${token}\n`, { mode: 0o600 });
  }
  // Raw copies for callers that expect a single bearer token in one file.
  for (const [team, token] of Object.entries(managerTokens)) {
    writeFileSync(join(DOGFOOD_DIR, `manager-${team}.token`), `${token}\n`, { mode: 0o600 });
  }

  // The rule is team-scoped by design (the frozen Rule type has no member
  // field). USD 0.01 is m3's request shape, so only m3's request matches it.
  const leader = await login(`leader-crew@example.test`, leaderPasswords[TEAM_CREW] ?? "");
  const ruleForm = new URLSearchParams({
    _csrf: leader.csrf,
    returnTo: "/rules",
    name: RULE_NAME,
    enabled: "1",
    kind: "budget_topup",
    maxUsd: "0.01",
    oncePerDays: "1",
  });
  const ruleResponse = await fetch(`${CONTROL_URL}/rules`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: leader.cookie.join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: ruleForm.toString(),
  });
  if (ruleResponse.status < 300 || ruleResponse.status >= 400) {
    throw new Error(`rule create failed: HTTP ${ruleResponse.status}`);
  }
  const rules = (await mustApi(
    leader,
    `/api/team/rules?teamId=${teams[TEAM_CREW] ?? ""}`,
    {},
    "rule list",
  )) as Array<{ id: string; name: string; condition: unknown }>;
  if (!rules.some((rule) => rule.name === RULE_NAME)) {
    throw new Error("the auto-approve rule is missing after the console save");
  }
  log(
    `rule "${RULE_NAME}" on ${TEAM_CREW}: ${rules.find((rule) => rule.name === RULE_NAME)?.id ?? "?"}`,
  );

  const repoMap: Record<string, string> = {};
  for (const id of REPO_MEMBERS) {
    const spec = MEMBERS.find((member) => member.id === id);
    if (spec === undefined) throw new Error(`no member spec for ${id}`);
    const memberId = memberIds[id];
    if (memberId === undefined) throw new Error(`member ${id} has no id`);
    const repo = writeRepo(spec);
    repoMap[`dogfood-${id}`] = memberId;
    log(`repo ${repo} -> ${memberId}`);
  }
  writeFileSync(MEMBERS_FILE, `${JSON.stringify(repoMap, null, 2)}\n`, { mode: 0o600 });

  writeFileSync(
    README_FILE,
    [
      "Team test scratch state. Delete at restore.",
      "",
      "keys/<member>.key    each member's gateway key, mode 0600",
      'manager.token        JSON {"crew": ..., "night": ...} manager API tokens, mode 0600',
      "manager-crew.token   the Crew leader's manager API token, mode 0600",
      "manager-night.token  the Night leader's manager API token, mode 0600",
      "logs/control.log     control-service log (no prompt or response text)",
      "repos/dogfood-m1..4  scratch git repositories for m1–m4",
      "state/admin.env      bootstrap admin credentials for cleanup, mode 0600",
      "state/stack.env      generated stack secrets, mode 0600",
      "",
      "Stack: gateway http://127.0.0.1:14020, control http://127.0.0.1:18082,",
      "webhook catcher http://127.0.0.1:18091, mail catcher http://127.0.0.1:18026.",
      "Stop with: node scripts/dogfood/stack.ts down",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  log(`members.json written with ${Object.keys(repoMap).length} repositories`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
