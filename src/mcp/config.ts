/**
 * Environment loading for the `taa` MCP servers and CLI.
 *
 * Canonical environment variable names (`TAA_BASE_URL`,
 * `TAA_MEMBER_KEY`, `TAA_MANAGER_TOKEN`). The worker brief also names
 * `TAA_URL`, `TAA_KEY` and `TAA_KEY_FILE`; those are accepted as aliases so
 * both spellings work. Secrets are never taken from argv.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

export class ConfigError extends Error {
  readonly code = "config";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Read the first non-empty value from `names` in `env`. */
function envValue(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * Read a secret from a file. The file must be readable only by its owner
 * (no group or other permission bits), otherwise a key on shared storage
 * could leak to other users. The value is trimmed of trailing whitespace.
 * The secret itself never appears in an error message.
 */
export async function readSecretFile(path: string): Promise<string> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError(`cannot read secret file: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `refusing secret file with group/other permissions (want mode 0600): ${path}`,
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read secret file: ${path}`);
  }
  const secret = text.replace(/[\r\n\s]+$/, "");
  if (secret === "") throw new ConfigError(`secret file is empty: ${path}`);
  return secret;
}

/** Resolve a secret from a direct value or a `*_FILE` path. The file wins when both are set. */
async function secretFromEnv(
  env: NodeJS.ProcessEnv,
  valueNames: readonly string[],
  fileNames: readonly string[],
): Promise<string | null> {
  const file = envValue(env, fileNames);
  if (file !== null) return readSecretFile(file);
  return envValue(env, valueNames);
}

function baseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = envValue(env, ["TAA_BASE_URL", "TAA_URL"]);
  if (raw === null) {
    throw new ConfigError("set the control-service URL with TAA_BASE_URL (or TAA_URL)");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("TAA_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("TAA_BASE_URL must start with http:// or https://");
  }
  return url.toString().replace(/\/+$/, "");
}

export interface MemberCredentials {
  readonly baseUrl: string;
  readonly key: string;
}

/** Member credential: base URL plus the member's gateway key. */
export async function loadMemberConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberCredentials> {
  const baseUrl = baseUrlFromEnv(env);
  const key = await secretFromEnv(
    env,
    ["TAA_MEMBER_KEY", "TAA_KEY"],
    ["TAA_MEMBER_KEY_FILE", "TAA_KEY_FILE"],
  );
  if (key === null) {
    throw new ConfigError(
      "set TAA_MEMBER_KEY (or TAA_KEY), or TAA_MEMBER_KEY_FILE (or TAA_KEY_FILE) with a mode-0600 file",
    );
  }
  return { baseUrl, key };
}

export interface ManagerCredentials {
  readonly baseUrl: string;
  readonly token: string;
}

/** Manager credential: base URL plus the manager API token. */
export async function loadManagerConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagerCredentials> {
  const baseUrl = baseUrlFromEnv(env);
  const token = await secretFromEnv(env, ["TAA_MANAGER_TOKEN"], ["TAA_MANAGER_TOKEN_FILE"]);
  if (token === null) {
    throw new ConfigError("set TAA_MANAGER_TOKEN, or TAA_MANAGER_TOKEN_FILE with a mode-0600 file");
  }
  return { baseUrl, token };
}
