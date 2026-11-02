/**
 * Verification: the four scratch repositories really route through the
 * allowance gateway.
 *
 * Per repository, in a throwaway clone:
 *   1. `opencode debug config` has to show the `allowance` provider, the
 *      `allowance/deepseek-v4.1-flash` model, the `taa` MCP desk and the
 *      plugin directory;
 *   2. one `opencode run` call answers "OK" through the gateway, and its logs
 *      show the OpenCode plugin being loaded.
 *
 * Each real call uses an isolated HOME, so the local user's own CLI settings are
 * never read or written, and counts toward that member's test budget; the
 * spend and request count are recorded per member.
 *
 * Usage:
 *   node scripts/dogfood/verify.ts
 *
 * Evidence: `~/.cache/taa-dogfood/evidence/verify.json`.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADMIN_ENV_FILE,
  CONTROL_URL,
  DOGFOOD_DIR,
  GATEWAY_URL,
  keyPath,
  MODEL,
  mainCheckout,
  PROVIDER_ID,
  REPO_MEMBERS,
  repoPath,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const CALL_TIMEOUT_MS = 180_000;
const USAGE_WAIT_MS = 30_000;

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-verify: ${line}\n`);
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(command: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function spawnRun(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\nspawn error: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readKey(memberId: string): string {
  const raw = readFileSync(keyPath(memberId), "utf8").trim();
  if (raw === "") throw new Error(`key file for ${memberId} is empty`);
  return raw;
}

async function keyInfoSpend(secret: string, masterKey: string): Promise<number> {
  const response = await fetch(`${GATEWAY_URL}/key/info?key=${sha256Hex(secret)}`, {
    headers: { authorization: `Bearer ${masterKey}` },
  });
  if (!response.ok) return -1;
  const body = (await response.json()) as { info?: { spend?: unknown } };
  const value = Number(body.info?.spend ?? 0);
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : -1;
}

interface Session {
  cookie: string[];
  csrf: string;
}

async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${CONTROL_URL}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
  });
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`admin login failed: HTTP ${response.status}`);
  }
  const cookie = (response.headers.getSetCookie?.() ?? []).map(
    (entry) => entry.split(";")[0] ?? "",
  );
  const session = await fetch(`${CONTROL_URL}/api/session`, {
    headers: { cookie: cookie.join("; ") },
  });
  const body = (await session.json()) as { csrfToken?: string };
  if (session.status !== 200 || body.csrfToken === undefined || body.csrfToken === "") {
    throw new Error("admin session failed");
  }
  return { cookie, csrf: body.csrfToken };
}

async function apiGet(session: Session, path: string): Promise<unknown> {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    headers: { cookie: session.cookie.join("; ") },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

interface UsageRow {
  costUsd: number;
  at: string;
  model: string;
}

async function usageRows(session: Session, memberId: string, teamId: string): Promise<UsageRow[]> {
  const body = (await apiGet(session, `/api/team/members/${memberId}?teamId=${teamId}`)) as {
    usage?: UsageRow[];
  };
  return body.usage ?? [];
}

interface MemberCheck {
  member: string;
  repo: string;
  memberId: string;
  clone: string;
  config: {
    pass: boolean;
    provider: boolean;
    model: boolean;
    mcp: boolean;
    plugin: boolean;
    excerpt: string;
  };
  call: {
    pass: boolean;
    status: number;
    answer: string;
    pluginLoaded: boolean;
    excerpt: string;
  };
  usage: {
    requests: number;
    spendUsd: number;
    keyInfoSpendUsd: number;
  };
}

async function main(): Promise<number> {
  const adminState = readEnvFile(ADMIN_ENV_FILE);
  const email = adminState.TAA_BOOTSTRAP_EMAIL;
  const password = adminState.TAA_BOOTSTRAP_PASSWORD;
  if (email === undefined || password === undefined)
    throw new Error("admin credentials are missing");
  const admin = await login(email, password);

  const stackSecrets = readEnvFile(join(DOGFOOD_DIR, "state", "stack.env"));
  const masterKey = stackSecrets.LITELLM_MASTER_KEY ?? "";
  if (masterKey === "") throw new Error("the gateway master key is missing");

  const teams = (await apiGet(admin, "/api/admin/teams")) as Array<{ id: string; name: string }>;
  const memberTeam = new Map<string, { teamId: string; teamName: string }>();
  for (const team of teams) {
    const members = (await apiGet(admin, `/api/team/members?teamId=${team.id}`)) as Array<{
      id: string;
    }>;
    for (const member of members) {
      memberTeam.set(member.id, { teamId: team.id, teamName: team.name });
    }
  }

  const members = JSON.parse(readFileSync(join(DOGFOOD_DIR, "members.json"), "utf8")) as Record<
    string,
    string
  >;
  const evidenceDir = join(DOGFOOD_DIR, "evidence");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

  const checks: MemberCheck[] = [];
  const opencode = (await exec("sh", ["-c", "command -v opencode"])).stdout.trim();
  if (opencode === "") throw new Error("opencode is not installed");

  for (const [index, id] of REPO_MEMBERS.entries()) {
    const repoName = `dogfood-${id}`;
    const memberId = members[repoName];
    if (memberId === undefined) throw new Error(`members.json has no id for ${repoName}`);
    const team = memberTeam.get(memberId);
    if (team === undefined) throw new Error(`member ${memberId} is in no team`);

    const clone = mkdtempSync(join(tmpdir(), `taa-dogfood-${id}-`));
    const home = mkdtempSync(join(tmpdir(), `taa-dogfood-home-${id}-`));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    mkdirSync(join(home, ".cache"), { recursive: true });
    const pluginState = join(home, "plugin-state");
    mkdirSync(pluginState, { recursive: true });

    try {
      const checkout = join(clone, "repo");
      const cloned = await exec("git", ["clone", "-q", repoPath(id), checkout]);
      if (cloned.code !== 0)
        throw new Error(`git clone failed for ${id}: ${cloned.stderr.slice(0, 200)}`);

      // The harness that runs this script may export OPENCODE_CONFIG_CONTENT
      // for its own session; OpenCode merges that above project config and it
      // would override the repository under test. Every OPENCODE_* variable is
      // dropped so the clone's own config is the only source.
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith("OPENCODE")) continue;
        env[key] = value;
      }
      env.HOME = home;
      // OpenCode resolves the project from PWD, not from the spawn cwd; the
      // parent shell's PWD would otherwise point at this worktree and the run
      // would use the wrong config.
      env.PWD = checkout;
      env.TAA_PLUGIN_STATE_DIR = pluginState;
      env.TAA_BASE_URL = CONTROL_URL;
      env.TAA_KEY_FILE = keyPath(id);
      const servicePort = 49200 + index * 7;
      await spawnRun(opencode, ["service", "set", "port", String(servicePort)], env, checkout);

      const debug = await spawnRun(opencode, ["debug", "config"], env, checkout);
      const configText = `${debug.stdout}\n${debug.stderr}`;
      const provider = configText.includes(`"${PROVIDER_ID}"`);
      const model =
        configText.includes(`"${MODEL}"`) && configText.includes(`"providerID": "${PROVIDER_ID}"`);
      const mcp = configText.includes('"taa"');
      const plugin = configText.includes(join(repoPath(id), ".opencode", "plugins"));
      const configPass = debug.code === 0 && provider && model && mcp && plugin;

      const before = await usageRows(admin, memberId, team.teamId);
      const spendBefore = await keyInfoSpend(readKey(id), masterKey);
      const run = await spawnRun(
        opencode,
        [
          "run",
          "--standalone",
          "--print-logs",
          "--log-level",
          "info",
          "--title",
          `routing check ${id}`,
          "-m",
          `${PROVIDER_ID}/${MODEL}`,
          "Reply with exactly OK and nothing else.",
        ],
        env,
        checkout,
      );
      const runText = `${run.stdout}\n${run.stderr}`;
      const answer = /(^|\n)\s*OK\s*(\n|$)/.test(run.stdout) ? "OK" : "";
      const pluginLoaded =
        runText.includes("loading plugin") && runText.includes("team-ai-allowance.ts");

      // The watcher records the rows within one poll; give it up to 30 s.
      const started = Date.now();
      let after = before;
      while (Date.now() - started < USAGE_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        after = await usageRows(admin, memberId, team.teamId);
        if (after.length > before.length) break;
      }
      const spendAfter = await keyInfoSpend(readKey(id), masterKey);
      const newRows = after.slice(before.length);
      const spendUsd =
        Math.round(newRows.reduce((sum, row) => sum + row.costUsd, 0) * 1_000_000) / 1_000_000;

      const check: MemberCheck = {
        member: id,
        repo: repoPath(id),
        memberId,
        clone,
        config: {
          pass: configPass,
          provider,
          model,
          mcp,
          plugin,
          excerpt: configText
            .split("\n")
            .filter((line) => /allowance|providerID|"model"|"taa"|plugins|\.opencode/.test(line))
            .slice(0, 12)
            .join("\n"),
        },
        call: {
          pass: run.code === 0 && answer === "OK",
          status: run.code,
          answer,
          pluginLoaded,
          excerpt: runText
            .split("\n")
            .filter((line) => /loading plugin.*team-ai-allowance|^OK$|Error/.test(line))
            .slice(0, 6)
            .join("\n"),
        },
        usage: {
          requests: newRows.length,
          spendUsd,
          keyInfoSpendUsd:
            spendBefore >= 0 && spendAfter >= 0
              ? Math.round((spendAfter - spendBefore) * 1_000_000) / 1_000_000
              : -1,
        },
      };
      checks.push(check);
      log(
        `${id}: config ${configPass ? "PASS" : "FAIL"} (provider ${provider}, model ${model}, ` +
          `mcp ${mcp}, plugin ${plugin}); call ${check.call.pass ? "PASS" : "FAIL"} ` +
          `(status ${run.code}, answer ${JSON.stringify(answer)}, plugin loaded ${pluginLoaded}); ` +
          `${newRows.length} request(s), USD ${spendUsd.toFixed(6)}`,
      );
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  const pass = checks.every(
    (check) => check.config.pass && check.call.pass && check.call.pluginLoaded,
  );
  const evidence = {
    at: new Date().toISOString(),
    gateway: GATEWAY_URL,
    control: CONTROL_URL,
    mainCheckout: mainCheckout(),
    model: MODEL,
    pass,
    checks,
  };
  writeFileSync(join(evidenceDir, "verify.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

  for (const check of checks) {
    process.stdout.write(
      `${check.member} ${check.config.pass ? "config-PASS" : "config-FAIL"} ` +
        `${check.call.pass ? "call-PASS" : "call-FAIL"} ` +
        `plugin-${check.call.pluginLoaded ? "loaded" : "MISSING"} ` +
        `requests=${check.usage.requests} spend=USD ${check.usage.spendUsd.toFixed(6)}\n`,
    );
  }
  process.stdout.write(`overall ${pass ? "PASS" : "FAIL"}\n`);
  return pass ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
