/**
 * Shared settings for the team test.
 *
 * Everything the dogfood runner writes lives outside every repository under
 * `~/.cache/taa-dogfood/` (overridable with `TAA_DOGFOOD_DIR`), and is deleted
 * at restore. No key, token or password is ever printed by these
 * scripts; values are passed through files with mode 0600.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root of the checkout these scripts run from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Scratch state for the team test: keys, repos, database, logs, evidence. */
export const DOGFOOD_DIR = process.env.TAA_DOGFOOD_DIR ?? join(homedir(), ".cache", "taa-dogfood");

export const KEYS_DIR = join(DOGFOOD_DIR, "keys");
export const REPOS_DIR = join(DOGFOOD_DIR, "repos");
export const LOGS_DIR = join(DOGFOOD_DIR, "logs");
export const VERIFY_DIR = join(DOGFOOD_DIR, "verify");

export const STATE_DIR = join(DOGFOOD_DIR, "state");
export const STACK_ENV_FILE = join(STATE_DIR, "stack.env");
export const PG_ENV_FILE = join(STATE_DIR, "postgres.env");
export const LITELLM_ENV_FILE = join(STATE_DIR, "litellm.env");
export const ADMIN_ENV_FILE = join(STATE_DIR, "admin.env");
export const CONTROL_PID_FILE = join(STATE_DIR, "control.pid");
export const CONTROL_LOG = join(LOGS_DIR, "control.log");
export const MEMBERS_FILE = join(DOGFOOD_DIR, "members.json");
export const MANAGER_TOKEN_FILE = join(DOGFOOD_DIR, "manager.token");
export const README_FILE = join(DOGFOOD_DIR, "README.txt");
export const DB_PATH = join(DOGFOOD_DIR, "taa.db");

/** Upstream credential file. Checked for existence only; never opened. */
export const UPSTREAM_ENV_FILE =
  process.env.TAA_UPSTREAM_ENV ?? join(homedir(), ".config", "team-ai-allowance", "upstream.env");

/** Isolated host ports: the dev stack uses 14000/18080/18090, the live check 14010/18081. */
export const PORTS = {
  gateway: Number(process.env.TAA_DOGFOOD_GATEWAY_PORT ?? "14020"),
  control: Number(process.env.TAA_DOGFOOD_CONTROL_PORT ?? "18082"),
  webhook: Number(process.env.TAA_DOGFOOD_WEBHOOK_PORT ?? "18091"),
  mailUi: Number(process.env.TAA_DOGFOOD_MAIL_UI_PORT ?? "18026"),
  smtp: Number(process.env.TAA_DOGFOOD_SMTP_PORT ?? "11025"),
  postgres: Number(process.env.TAA_DOGFOOD_POSTGRES_PORT ?? "15433"),
} as const;

export const GATEWAY_URL = `http://127.0.0.1:${PORTS.gateway}`;
export const CONTROL_URL = `http://127.0.0.1:${PORTS.control}`;
export const WEBHOOK_URL = `http://127.0.0.1:${PORTS.webhook}/notify`;

export const NETWORK = "taa-dogfood-net";
export const CONTAINERS = {
  postgres: "taa-dogfood-postgres",
  litellm: "taa-dogfood-litellm",
  webhook: "taa-dogfood-webhook",
  mail: "taa-dogfood-mail",
} as const;

export const LITELLM_IMAGE =
  "ghcr.io/berriai/litellm:v1.105.1@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802";
export const POSTGRES_IMAGE = "docker.io/library/postgres:17-alpine";
export const NODE_IMAGE = "docker.io/library/node:24-alpine";
export const MAIL_IMAGE = "docker.io/mailhog/mailhog:v1.0.1";

export const GATEWAY_CONFIG = join(ROOT, "deploy", "litellm.dogfood.yaml");
export const WEBHOOK_SCRIPT = join(ROOT, "deploy", "webhook-catcher.mjs");
export const PLUGIN_PATH = join(ROOT, "dist", "plugin", "team-ai-allowance.ts");

/** Model ids shared by the gateway config and the control-service catalogue. */
export const MODEL = "deepseek-v4.1-flash";
export const FLAGSHIP = "flagship";
export const BLOCKED_MODEL = "blocked-model";
export const PROVIDER_ID = "allowance";

export const TEAM_CREW = "Crew";
export const TEAM_NIGHT = "Night";
export const MANAGER_NAME = "Leader";
export const ADMIN_EMAIL = "dogfood-admin@example.test";
export const MANAGER_EMAIL_SUFFIX = "@example.test";
export const MAIL_TO = "leader@example.test";

/** Test-denominated catalogue prices: the same figures as the gateway config. */
export const MODEL_PRICE = { inputPer1MUsd: 5, outputPer1MUsd: 15 } as const;

export interface MemberSpec {
  /** Key file basename and scratch repo suffix for m1–m4. */
  id: string;
  displayName: string;
  team: string;
  budgetUsd: number;
  period: "daily" | "weekly" | "monthly";
  tokenCap: number | null;
}

/**
 * Team-test members and probe members. Budgets are tiny on purpose: the test
 * exists to make limits bite.
 */
export const MEMBERS: readonly MemberSpec[] = [
  {
    id: "m1",
    displayName: "Mira",
    team: TEAM_CREW,
    budgetUsd: 0.02,
    period: "daily",
    tokenCap: null,
  },
  {
    id: "m2",
    displayName: "Nils",
    team: TEAM_CREW,
    budgetUsd: 0.04,
    period: "daily",
    tokenCap: null,
  },
  {
    id: "m3",
    displayName: "Edda",
    team: TEAM_CREW,
    budgetUsd: 0.02,
    period: "daily",
    tokenCap: null,
  },
  // The Night team's off-hours cap (USD 0.01) is what has to bite for m4, so
  // its ordinary budget sits above the cap.
  {
    id: "m4",
    displayName: "Bo",
    team: TEAM_NIGHT,
    budgetUsd: 0.1,
    period: "daily",
    tokenCap: null,
  },
  {
    id: "p1",
    displayName: "Ines",
    team: TEAM_CREW,
    budgetUsd: 0.05,
    period: "daily",
    tokenCap: 3000,
  },
  {
    id: "p2",
    displayName: "Rune",
    team: TEAM_CREW,
    budgetUsd: 0.05,
    period: "daily",
    tokenCap: null,
  },
  {
    id: "p3",
    displayName: "Vera",
    team: TEAM_NIGHT,
    budgetUsd: 0.05,
    period: "daily",
    tokenCap: null,
  },
] as const;

/** Scratch repositories: one per worker member (m1–m4). */
export const REPO_MEMBERS = ["m1", "m2", "m3", "m4"] as const;

/**
 * The team-ai-allowance main checkout. The scratch repos register its
 * `taa mcp` and the control service runs from it, so the worker repos keep working from the main checkout. Overridable with `TAA_MAIN_CHECKOUT`.
 */
export function mainCheckout(): string {
  const override = process.env.TAA_MAIN_CHECKOUT?.trim();
  if (override !== undefined && override !== "") return resolve(override);
  try {
    const listing = execFileSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    for (const line of listing.split("\n")) {
      if (line.startsWith("worktree ")) return resolve(line.slice("worktree ".length));
    }
  } catch {
    // Fall through to the running checkout.
  }
  return ROOT;
}

export function repoPath(memberId: string): string {
  return join(REPOS_DIR, `dogfood-${memberId}`);
}

export function keyPath(memberId: string): string {
  return join(KEYS_DIR, `${memberId}.key`);
}
