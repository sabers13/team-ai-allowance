/**
 * CLI output: short plain text by default, JSON with `--json`, and the
 * CLI exit codes: 0 success, 1 refused by the
 * service, 2 usage or config, 3 network or service failure.
 */

import { ApiError, ConfigError } from "../mcp/index.ts";
import { UsageError } from "./args.ts";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NETWORK = 3;

/** Print a command result: text normally, the data as JSON with `--json`. */
export function printResult(text: string, data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

/** Map a caught error to an exit code and a one-line stderr message. */
export function exitFor(error: unknown): number {
  if (error instanceof UsageError || error instanceof ConfigError) {
    process.stderr.write(`taa: ${error.message}\n`);
    return EXIT_USAGE;
  }
  if (error instanceof ApiError) {
    if (error.isNetwork() || error.status >= 500) {
      process.stderr.write(`taa: ${error.message}\n`);
      return EXIT_NETWORK;
    }
    process.stderr.write(`taa: ${error.message}\n`);
    return EXIT_REFUSED;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taa: unexpected failure: ${message}\n`);
  return EXIT_NETWORK;
}
