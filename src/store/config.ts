import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The store's one config module. `TAA_DB_PATH` is the only variable it reads
 * via `TAA_DB_PATH`; the default lives under `./var/`.
 */
export const DEFAULT_DB_PATH = "./var/taa.db";

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TAA_DB_PATH?.trim();
  const path = configured === undefined || configured.length === 0 ? DEFAULT_DB_PATH : configured;
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
