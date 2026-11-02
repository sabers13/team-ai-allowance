/**
 * Environment-file helpers shared by the dogfood scripts.
 *
 * These files are written by `stack.ts` with mode 0600 and only ever read by
 * the other dogfood scripts. No value is ever printed.
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Minimal KEY=VALUE reader for the files this package wrote itself. */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

/** Write a 0600 KEY=VALUE file, replacing any previous contents. */
export function writeEnvFile(path: string, values: Record<string, string>): void {
  const body = `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  writeFileSync(path, body, { mode: 0o600 });
}
