/**
 * The `taa serve` configuration.
 *
 * This is the only file under `src/server/` that reads `process.env`. Every
 * other module in the server takes a `ServerConfig`, so a test can build one
 * from a literal without touching the environment.
 *
 * Secrets are checked for presence and never echoed. `TAA_DEV_SECRETS=1`
 * generates throwaway session and CSRF secrets for a local run (the demo and
 * the e2e harness); it is refused when `NODE_ENV=production`.
 */

import { randomBytes } from "node:crypto";

import { type ApiConfig, createApiConfig, DEFAULT_PUBLIC_URL } from "../api/index.ts";
import { DEFAULT_DB_PATH } from "../store/index.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18080;
export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000;
export const DEFAULT_WATCH_INTERVAL_MS = 30_000;
const MIN_SECRET_LENGTH = 32;

export interface GatewaySettings {
  baseUrl: string;
  masterKey: string;
  timeoutMs: number;
}

export interface BootstrapSettings {
  /** E-mail of the account created on first start. */
  email: string;
  /** Clear password; hashed with scrypt before it reaches the store. */
  password: string;
  displayName: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  dbPath: string;
  api: ApiConfig;
  gateway: GatewaySettings;
  reconcileIntervalMs: number;
  watchIntervalMs: number;
  /** Create this admin account on first start, when nothing exists yet. */
  bootstrap: BootstrapSettings | null;
  /** Seed the demo org, team, members and models on first start. */
  demoSeed: boolean;
  /** How long first-start seeding waits for the gateway to answer health. */
  gatewayWaitMs: number;
  /** Clear password for the demo manager's console login; never logged. */
  demoManagerPassword: string | null;
  /** Throwaway secrets were generated for a local run. */
  generatedSecrets: boolean;
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ServerConfigError(`${name} must be a positive whole number.`);
  }
  return parsed;
}

function port(value: string | undefined): number {
  const parsed = positiveInt(value, DEFAULT_PORT, "TAA_PORT");
  if (parsed > 65_535) throw new ServerConfigError("TAA_PORT must be 65535 or lower.");
  return parsed;
}

function secret(env: NodeJS.ProcessEnv, name: string, generated: { used: boolean }): string {
  const configured = text(env[name]);
  if (configured !== null) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new ServerConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    return configured;
  }
  if (env.TAA_DEV_SECRETS === "1") {
    generated.used = true;
    return randomBytes(32).toString("hex");
  }
  throw new ServerConfigError(
    `${name} is not set. Provide it, or set TAA_DEV_SECRETS=1 for a local run.`,
  );
}

function bootstrap(env: NodeJS.ProcessEnv): BootstrapSettings | null {
  const email = text(env.TAA_BOOTSTRAP_EMAIL);
  const password = text(env.TAA_BOOTSTRAP_PASSWORD);
  if (email === null && password === null) return null;
  if (email === null || password === null) {
    throw new ServerConfigError(
      "TAA_BOOTSTRAP_EMAIL and TAA_BOOTSTRAP_PASSWORD must be set together.",
    );
  }
  if (password.length < 12) {
    throw new ServerConfigError("TAA_BOOTSTRAP_PASSWORD must be at least 12 characters.");
  }
  return {
    email,
    password,
    displayName: text(env.TAA_BOOTSTRAP_NAME) ?? "Team admin",
  };
}

function gateway(env: NodeJS.ProcessEnv): GatewaySettings {
  const baseUrl = text(env.TAA_GATEWAY_URL);
  const masterKey = text(env.LITELLM_MASTER_KEY);
  if (baseUrl === null) {
    throw new ServerConfigError("TAA_GATEWAY_URL is not set.");
  }
  if (masterKey === null) {
    throw new ServerConfigError("LITELLM_MASTER_KEY is not set.");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ServerConfigError("TAA_GATEWAY_URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ServerConfigError("TAA_GATEWAY_URL must be an absolute http(s) URL.");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    masterKey,
    timeoutMs: positiveInt(env.TAA_GATEWAY_TIMEOUT_MS, 15_000, "TAA_GATEWAY_TIMEOUT_MS"),
  };
}

export interface ServerConfigInput {
  env?: NodeJS.ProcessEnv;
  /** Overrides `TAA_PORT`; `taa serve --port` uses this. */
  port?: number;
}

/** Read and validate every variable `taa serve` needs. */
export function loadServerConfig(input: ServerConfigInput = {}): ServerConfig {
  const env = input.env ?? process.env;
  const generated = { used: false };
  const publicUrl = text(env.TAA_PUBLIC_URL) ?? DEFAULT_PUBLIC_URL;
  const chosenPort = input.port ?? port(env.TAA_PORT);
  const api = createApiConfig({
    sessionSecret: secret(env, "TAA_SESSION_SECRET", generated),
    csrfSecret: secret(env, "TAA_CSRF_SECRET", generated),
    publicUrl,
  });
  return {
    host: text(env.TAA_HOST) ?? DEFAULT_HOST,
    port: chosenPort,
    publicUrl: api.publicUrl,
    dbPath: text(env.TAA_DB_PATH) ?? DEFAULT_DB_PATH,
    api,
    gateway: gateway(env),
    reconcileIntervalMs: positiveInt(
      env.TAA_RECONCILE_INTERVAL_MS,
      DEFAULT_RECONCILE_INTERVAL_MS,
      "TAA_RECONCILE_INTERVAL_MS",
    ),
    watchIntervalMs: positiveInt(
      env.TAA_WATCH_INTERVAL_MS,
      DEFAULT_WATCH_INTERVAL_MS,
      "TAA_WATCH_INTERVAL_MS",
    ),
    bootstrap: bootstrap(env),
    demoSeed: env.TAA_DEMO_SEED === "1",
    gatewayWaitMs: positiveInt(env.TAA_GATEWAY_WAIT_MS, 60_000, "TAA_GATEWAY_WAIT_MS"),
    demoManagerPassword: text(env.TAA_DEMO_MANAGER_PASSWORD),
    generatedSecrets: generated.used,
  };
}
