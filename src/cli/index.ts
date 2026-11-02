#!/usr/bin/env node
/**
 * `taa` command line entry point.
 *
 * Member desk and manager desk over the control-service API, plus the stdio
 * MCP servers, `serve` (control service and console) and `sim` (weekend
 * simulation).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ApiClient,
  ConfigError,
  defaultHintsPath,
  type HintsFile,
  loadMemberConfig,
  parseHintsFile,
  runMcp,
} from "../mcp/index.ts";
import {
  createControlServer,
  loadServerConfig,
  type ServerConfig,
  ServerConfigError,
} from "../server/index.ts";
import { loadPrices, runAllScenarios, serializeResult, simPrices } from "../sim/index.ts";
import { SCENARIOS } from "../sim/simulate.ts";
import { hasFlag, optionalFlag, parseArgs, UsageError } from "./args.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { commandAudit, commandBlock, commandDecide } from "./manager.ts";
import { commandRequest, commandRequests, commandStatus } from "./member.ts";
import { EXIT_OK, EXIT_USAGE, exitFor, printResult } from "./output.ts";

function usage(): string {
  return [
    "Usage: taa <command> [options]",
    "",
    "Commands:",
    "  mcp                  serve the stdio MCP request desk [--role member|manager]",
    "  status [--json]      show my allowance",
    "  request more-budget --amount <usd> [--until <date>] --reason <text>",
    "  request model <id> [--hours <n>] --reason <text>",
    "  request suggestion --reason <text>",
    "  requests [--pending] [--state <s>] [--limit <n>] [--team] [--json]",
    "  decide <id> approve|partly|deny [--usd N] [--until DATE] --note ...",
    "  block <member> --note ...",
    "  unblock <member>",
    "  audit [--export <file>] [--limit N] [--json]",
    "  doctor [--post] [--json]",
    "  hints import <file>",
    "  serve                start the control service and console",
    "  sim                  run the deterministic weekend simulation",
    "",
    "Secrets come from the environment (TAA_MEMBER_KEY, TAA_MANAGER_TOKEN,",
    "TAA_BASE_URL) or a mode-0600 file (TAA_*_FILE); never from argv.",
  ].join("\n");
}

async function commandHints(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseArgs(argv);
  const [action, file] = args.positionals;
  if (action !== "import" || file === undefined || file === "") {
    throw new UsageError("taa hints import <file>");
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`taa hints import: cannot read ${file}`);
  }
  let hints: HintsFile;
  try {
    hints = parseHintsFile(text);
  } catch (error) {
    throw new UsageError(
      `taa hints import: ${file}: ${error instanceof Error ? error.message : "invalid file"}`,
    );
  }
  const dest = defaultHintsPath(env);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, `${JSON.stringify({ version: 1, hints: hints.hints }, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`imported ${hints.hints.length} hint(s) to ${dest}\n`);
}

async function commandSim(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.positionals.length > 0) throw new UsageError("taa sim [--out <dir>]");
  const root = process.cwd();
  const table = loadPrices(join(root, "config", "prices.json"));
  const results = runAllScenarios(simPrices(table));
  const outDir = optionalFlag(args, "out") ?? join(root, "results", "sim");
  await mkdir(outDir, { recursive: true });
  for (let index = 0; index < results.length; index += 1) {
    const scenario = SCENARIOS[index];
    const result = results[index];
    if (scenario === undefined || result === undefined) continue;
    const path = join(outDir, `${scenario.name}.json`);
    await writeFile(path, serializeResult(result), "utf8");
    process.stdout.write(
      `sim: ${scenario.name}: ${result.stop.reason} at step ${result.stop.step} (${result.stop.t}), USD ${result.stop.spendUsd.toFixed(2)}\n`,
    );
  }
}

async function commandDoctor(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseArgs(argv);
  if (args.positionals.length > 0) throw new UsageError("taa doctor takes no arguments");
  const json = hasFlag(args, "json");
  const report = await runDoctor(env);
  if (json) {
    printResult("", report, true);
  } else {
    process.stdout.write(`${formatDoctor(report, env)}\n`);
  }
  if (hasFlag(args, "post")) {
    const config = await loadMemberConfig(env);
    const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.key });
    try {
      await api.postDoctorReport(report);
      process.stderr.write("doctor report posted\n");
    } catch (error) {
      if (error instanceof Error && /404/.test(error.message)) {
        process.stderr.write("note: the control service does not accept doctor reports yet\n");
      } else {
        throw error;
      }
    }
  }
}

async function commandMcp(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    await runMcp(argv, env);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) {
      process.stderr.write(`taa mcp: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

async function commandServe(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseArgs(argv);
  const rawPort = args.flags.get("port");
  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsed = typeof rawPort === "string" ? Number.parseInt(rawPort, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
      throw new UsageError("taa serve: --port must be a number from 1 to 65535");
    }
    port = parsed;
  }
  let config: ServerConfig;
  try {
    config = loadServerConfig({ env, ...(port === undefined ? {} : { port }) });
  } catch (error) {
    if (error instanceof ServerConfigError) {
      process.stderr.write(`taa serve: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const server = await createControlServer({ config, env });
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`serve: ${signal}, shutting down\n`);
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  await server.start();
  return new Promise<number>(() => {
    // The server keeps the process alive until a signal closes it.
  });
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  switch (command) {
    case "mcp":
      return commandMcp(rest, env);
    case "status":
      await commandStatus(rest, env);
      return EXIT_OK;
    case "request":
      await commandRequest(rest, env);
      return EXIT_OK;
    case "requests":
      await commandRequests(rest, env);
      return EXIT_OK;
    case "decide":
      await commandDecide(rest, env);
      return EXIT_OK;
    case "block":
      await commandBlock(rest, env, true);
      return EXIT_OK;
    case "unblock":
      await commandBlock(rest, env, false);
      return EXIT_OK;
    case "audit":
      await commandAudit(rest, env);
      return EXIT_OK;
    case "doctor":
      await commandDoctor(rest, env);
      return EXIT_OK;
    case "hints":
      await commandHints(rest, env);
      return EXIT_OK;
    case "serve":
      return commandServe(rest, env);
    case "sim":
      await commandSim(rest);
      return EXIT_OK;
    default:
      process.stderr.write(`taa: unknown command "${command}"\n\n${usage()}\n`);
      return EXIT_USAGE;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  if (error instanceof UsageError || error instanceof ConfigError) {
    process.stderr.write(`taa: ${(error as Error).message}\n`);
    process.exitCode = EXIT_USAGE;
  } else {
    process.exitCode = exitFor(error);
  }
}
