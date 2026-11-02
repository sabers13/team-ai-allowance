/**
 * Bring the dogfood stack up or down.
 *
 * The stack is the same shape as the live check, isolated from every other
 * stack on the machine:
 *
 *   postgres   taa-dogfood-postgres   127.0.0.1:15433
 *   gateway    taa-dogfood-litellm    127.0.0.1:14020   deploy/litellm.dogfood.yaml
 *   webhook    taa-dogfood-webhook    127.0.0.1:18091   deploy/webhook-catcher.mjs
 *   mail       taa-dogfood-mail       127.0.0.1:18026 (UI), 127.0.0.1:11025 (SMTP)
 *   control    `taa serve` from the main checkout, 127.0.0.1:18082
 *
 * The upstream credential reaches the gateway container through
 * `--env-file ~/.config/team-ai-allowance/upstream.env`. This script checks
 * that the file exists and never opens, prints or copies it. Every generated
 * secret lives in `~/.cache/taa-dogfood/state/*.env` with mode 0600.
 *
 * Usage:
 *   node scripts/dogfood/stack.ts up|down|status
 *   node scripts/dogfood/stack.ts down --purge   # also delete the control DB and secrets
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { openSqliteStore } from "../../src/store/index.ts";
import {
  ADMIN_ENV_FILE,
  CONTAINERS,
  CONTROL_LOG,
  CONTROL_PID_FILE,
  CONTROL_URL,
  DB_PATH,
  DOGFOOD_DIR,
  FLAGSHIP,
  GATEWAY_CONFIG,
  GATEWAY_URL,
  KEYS_DIR,
  LITELLM_ENV_FILE,
  LITELLM_IMAGE,
  LOGS_DIR,
  MAIL_IMAGE,
  MODEL,
  MODEL_PRICE,
  mainCheckout,
  NETWORK,
  NODE_IMAGE,
  PG_ENV_FILE,
  PORTS,
  POSTGRES_IMAGE,
  REPOS_DIR,
  ROOT,
  STACK_ENV_FILE,
  STATE_DIR,
  UPSTREAM_ENV_FILE,
  VERIFY_DIR,
  WEBHOOK_SCRIPT,
} from "./config.ts";
import { readEnvFile, writeEnvFile } from "./env.ts";

const MIGRATIONS_WAIT_MS = 240_000;

/**
 * The gateway's Postgres data, kept in a named volume.
 *
 * Without it `podman run` creates an anonymous volume, `down` orphans it with
 * `podman rm -f`, and the next `up` starts an empty gateway: every member key,
 * budget and spend row silently disappears on a restart.
 */
const PG_VOLUME = "taa-dogfood-pgdata";

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-stack: ${line}\n`);
}

async function exec(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
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

async function detectRuntime(): Promise<"podman" | "docker"> {
  for (const candidate of ["podman", "docker"] as const) {
    const out = await exec(candidate, ["--version"]);
    if (out.code === 0) return candidate;
  }
  throw new Error("neither podman nor docker is available");
}

async function waitFor(url: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(`${label} did not become healthy at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function ensureState(): Record<string, string> {
  for (const dir of [DOGFOOD_DIR, KEYS_DIR, REPOS_DIR, LOGS_DIR, VERIFY_DIR, STATE_DIR]) {
    ensureDir(dir);
  }
  if (!existsSync(STACK_ENV_FILE)) {
    const values = {
      POSTGRES_PASSWORD: randomHex(24),
      LITELLM_MASTER_KEY: `sk-dogfood-${randomHex(24)}`,
      TAA_SESSION_SECRET: randomHex(32),
      TAA_CSRF_SECRET: randomHex(32),
      TAA_BOOTSTRAP_PASSWORD: randomHex(16),
    };
    writeEnvFile(STACK_ENV_FILE, values);
    log(`generated secrets in ${STACK_ENV_FILE} (mode 600); values are not printed`);
  }
  const state = readEnvFile(STACK_ENV_FILE);
  writeEnvFile(PG_ENV_FILE, {
    POSTGRES_USER: "litellm",
    POSTGRES_DB: "litellm",
    POSTGRES_PASSWORD: state.POSTGRES_PASSWORD ?? "",
  });
  writeEnvFile(LITELLM_ENV_FILE, {
    DATABASE_URL: `postgresql://litellm:${state.POSTGRES_PASSWORD ?? ""}@${CONTAINERS.postgres}:5432/litellm`,
    LITELLM_MASTER_KEY: state.LITELLM_MASTER_KEY ?? "",
  });
  writeEnvFile(ADMIN_ENV_FILE, {
    TAA_BOOTSTRAP_EMAIL: "dogfood-admin@example.test",
    TAA_BOOTSTRAP_PASSWORD: state.TAA_BOOTSTRAP_PASSWORD ?? "",
    TAA_BOOTSTRAP_NAME: "Dogfood admin",
  });
  return state;
}

/**
 * Create the SQLite file with a `Platform` team and the real model catalogue
 * before the control service starts.
 *
 * The server's first-start seed takes an early-return path when a team called
 * `Platform` already exists: it creates the bootstrap admin and nothing else,
 * so no mock models, demo members or history land in the dogfood database.
 * The catalogue has no HTTP write route (the console page is read-only), so
 * the three catalogue names are seeded here through the same store the
 * server opens.
 */
async function prepareDatabase(): Promise<void> {
  const store = openSqliteStore({ path: DB_PATH });
  try {
    const teams = await store.listTeams();
    if (!teams.some((team) => team.name === "Platform")) {
      await store.createTeam({ name: "Platform", monthlyBudgetUsd: 120 });
      log(`database: created ${DB_PATH} with the Platform placeholder team`);
    }
    await store.upsertModel({
      id: MODEL,
      displayName: "DeepSeek V4.1 Flash",
      route: `openai/${MODEL}`,
      inputPer1MUsd: MODEL_PRICE.inputPer1MUsd,
      outputPer1MUsd: MODEL_PRICE.outputPer1MUsd,
      state: "enabled",
      sortOrder: 1,
    });
    await store.upsertModel({
      id: FLAGSHIP,
      displayName: "Flagship (same upstream)",
      route: `openai/${MODEL}`,
      inputPer1MUsd: MODEL_PRICE.inputPer1MUsd,
      outputPer1MUsd: MODEL_PRICE.outputPer1MUsd,
      state: "approval-required",
      sortOrder: 2,
    });
    await store.upsertModel({
      id: "blocked-model",
      displayName: "Blocked model",
      route: "blocked/blocked-model",
      inputPer1MUsd: 0,
      outputPer1MUsd: 0,
      state: "blocked",
      sortOrder: 99,
    });
  } finally {
    store.close();
  }
}

async function ensureNetwork(runtime: string): Promise<void> {
  const inspect = await exec(runtime, ["network", "inspect", NETWORK]);
  if (inspect.code === 0) return;
  const created = await exec(runtime, ["network", "create", NETWORK]);
  if (created.code !== 0) throw new Error(`network create failed: ${created.stderr.slice(0, 300)}`);
  log(`network ${NETWORK} created`);
}

async function containerState(runtime: string, name: string): Promise<string | null> {
  const out = await exec(runtime, ["inspect", "--format", "{{.State.Status}}", name]);
  if (out.code !== 0) return null;
  return out.stdout.trim();
}

async function ensureContainer(runtime: string, name: string, runArgs: string[]): Promise<void> {
  const state = await containerState(runtime, name);
  if (state === "running") return;
  if (state !== null) {
    const started = await exec(runtime, ["start", name]);
    if (started.code !== 0)
      throw new Error(`start ${name} failed: ${started.stderr.slice(0, 300)}`);
    log(`container ${name} restarted`);
    return;
  }
  const created = await exec(runtime, ["run", "-d", "--name", name, ...runArgs], {
    timeoutMs: 180_000,
  });
  if (created.code !== 0) throw new Error(`run ${name} failed: ${created.stderr.slice(0, 300)}`);
  log(`container ${name} started`);
}

async function startContainers(runtime: string): Promise<void> {
  if (!existsSync(UPSTREAM_ENV_FILE)) {
    throw new Error(
      `upstream key file is missing: ${UPSTREAM_ENV_FILE} (nothing was read or created)`,
    );
  }

  await ensureContainer(runtime, CONTAINERS.postgres, [
    "--network",
    NETWORK,
    "-p",
    `127.0.0.1:${PORTS.postgres}:5432`,
    "-v",
    `${PG_VOLUME}:/var/lib/postgresql/data`,
    "--env-file",
    PG_ENV_FILE,
    POSTGRES_IMAGE,
  ]);
  for (let i = 0; i < 60; i++) {
    const ready = await exec(runtime, [
      "exec",
      CONTAINERS.postgres,
      "pg_isready",
      "-U",
      "litellm",
      "-d",
      "litellm",
    ]);
    if (ready.code === 0) break;
    if (i === 59) throw new Error("postgres never became ready");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  await ensureContainer(runtime, CONTAINERS.litellm, [
    "--network",
    NETWORK,
    "-p",
    `127.0.0.1:${PORTS.gateway}:4000`,
    "--env-file",
    UPSTREAM_ENV_FILE,
    "--env-file",
    LITELLM_ENV_FILE,
    "-v",
    `${GATEWAY_CONFIG}:/app/config.yaml:ro`,
    LITELLM_IMAGE,
    "--config",
    "/app/config.yaml",
    "--port",
    "4000",
    "--num_workers",
    "1",
  ]);

  await ensureContainer(runtime, CONTAINERS.webhook, [
    "--network",
    NETWORK,
    "-p",
    `127.0.0.1:${PORTS.webhook}:8090`,
    "-e",
    "PORT=8090",
    "-v",
    `${WEBHOOK_SCRIPT}:/app/webhook-catcher.mjs:ro`,
    "-v",
    `${join(ROOT, "deploy", "container-package.json")}:/app/package.json:ro`,
    "--workdir",
    "/app",
    NODE_IMAGE,
    "node",
    "webhook-catcher.mjs",
  ]);

  await ensureContainer(runtime, CONTAINERS.mail, [
    "--network",
    NETWORK,
    "-p",
    `127.0.0.1:${PORTS.mailUi}:8025`,
    "-p",
    `127.0.0.1:${PORTS.smtp}:1025`,
    "-e",
    "MH_STORAGE=memory",
    MAIL_IMAGE,
  ]);

  await waitFor(`${GATEWAY_URL}/health/liveliness`, MIGRATIONS_WAIT_MS, "dogfood gateway");
  await waitFor(`http://127.0.0.1:${PORTS.webhook}/`, 30_000, "dogfood webhook catcher");
  await waitFor(`http://127.0.0.1:${PORTS.mailUi}/`, 30_000, "dogfood mail catcher");
}

function controlEnv(state: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAA_HOST: "127.0.0.1",
    TAA_PORT: String(PORTS.control),
    TAA_PUBLIC_URL: CONTROL_URL,
    TAA_DB_PATH: DB_PATH,
    TAA_GATEWAY_URL: GATEWAY_URL,
    LITELLM_MASTER_KEY: state.LITELLM_MASTER_KEY ?? "",
    TAA_SESSION_SECRET: state.TAA_SESSION_SECRET ?? "",
    TAA_CSRF_SECRET: state.TAA_CSRF_SECRET ?? "",
    TAA_BOOTSTRAP_EMAIL: "dogfood-admin@example.test",
    TAA_BOOTSTRAP_PASSWORD: state.TAA_BOOTSTRAP_PASSWORD ?? "",
    TAA_BOOTSTRAP_NAME: "Dogfood admin",
    TAA_GENERIC_WEBHOOK: `http://127.0.0.1:${PORTS.webhook}/notify`,
    TAA_SMTP_URL: `smtp://127.0.0.1:${PORTS.smtp}`,
    TAA_MAIL_TO: "leader@example.test",
    TAA_MAIL_FROM: "team-ai-allowance@example.test",
    // The watcher has to react inside a worker's session, not after minutes.
    TAA_WATCH_INTERVAL_MS: "5000",
    TAA_RECONCILE_INTERVAL_MS: "10000",
    TAA_GATEWAY_WAIT_MS: "240000",
    TAA_DEMO_SEED: "0",
  };
}

function controlPid(): number | null {
  try {
    const raw = readFileSync(CONTROL_PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startControl(state: Record<string, string>): Promise<void> {
  const existing = controlPid();
  if (existing !== null && pidAlive(existing)) {
    const health = await fetch(`${CONTROL_URL}/health`, { signal: AbortSignal.timeout(3000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (health) {
      log(`control already up at ${CONTROL_URL} (pid ${existing})`);
      return;
    }
    log(`control pid ${existing} is alive but not healthy; restarting it`);
    try {
      process.kill(existing, "SIGTERM");
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const main = mainCheckout();
  const fd = openSync(CONTROL_LOG, "a", 0o600);
  const child = spawn(process.execPath, [join(main, "src", "cli", "index.ts"), "serve"], {
    cwd: main,
    env: controlEnv(state),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  if (child.pid === undefined) throw new Error("control service did not start");
  writeFileSync(CONTROL_PID_FILE, `${child.pid}\n`, { mode: 0o600 });
  log(`control starting from ${main} (pid ${child.pid})`);
  await waitFor(`${CONTROL_URL}/health`, MIGRATIONS_WAIT_MS, "dogfood control service");
}

async function stopControl(): Promise<void> {
  const pid = controlPid();
  if (pid !== null && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 20 && pidAlive(pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    log(`control stopped (pid ${pid})`);
  }
  rmSync(CONTROL_PID_FILE, { force: true });
}

async function up(): Promise<number> {
  const runtime = await detectRuntime();
  const state = ensureState();
  ensureDir(join(DOGFOOD_DIR, "state"));
  await ensureNetwork(runtime);
  await prepareDatabase();
  await startContainers(runtime);
  await startControl(state);
  log(`stack up: gateway ${GATEWAY_URL}, control ${CONTROL_URL}`);
  return 0;
}

async function down(purge: boolean): Promise<number> {
  const runtime = await detectRuntime();
  await stopControl();
  for (const name of Object.values(CONTAINERS)) {
    await exec(runtime, ["stop", "-t", "10", name]);
    await exec(runtime, ["rm", "-f", name]);
  }
  log(`containers stopped: ${Object.values(CONTAINERS).join(", ")}`);
  if (purge) {
    rmSync(DB_PATH, { force: true });
    rmSync(STACK_ENV_FILE, { force: true });
    await exec(runtime, ["volume", "rm", "-f", PG_VOLUME]);
    log("purged the control database, the generated stack secrets and the gateway volume");
  }
  return 0;
}

async function status(): Promise<number> {
  const runtime = await detectRuntime();
  for (const name of Object.values(CONTAINERS)) {
    const state = await containerState(runtime, name);
    log(`${name}: ${state ?? "absent"}`);
  }
  const pid = controlPid();
  log(`control: ${pid !== null && pidAlive(pid) ? `pid ${pid}` : "absent"}`);
  const health = await fetch(`${CONTROL_URL}/health`, { signal: AbortSignal.timeout(3000) })
    .then((response) => `HTTP ${response.status}`)
    .catch(() => "unreachable");
  log(`control health: ${health}`);
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "status";
  const purge = process.argv.includes("--purge");
  if (command === "up") return up();
  if (command === "down") return down(purge);
  if (command === "status") return status();
  process.stderr.write("usage: node scripts/dogfood/stack.ts up|down|status [--purge]\n");
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
