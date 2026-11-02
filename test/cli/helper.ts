/**
 * Shared async CLI runner for `test/cli/` (not a test file itself).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const CLI = join(ROOT, "src", "cli", "index.ts");

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn the real CLI without blocking the event loop (see commands.test.ts). */
export function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}
