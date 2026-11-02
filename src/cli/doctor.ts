/**
 * `taa doctor`: read-only machine check. It reports the installed CLI
 * versions, whether each CLI points at the gateway and registers the `taa`
 * MCP server, whether a managed config pins anything, and whether the
 * control service answers. It never writes outside an explicit `--export`
 * and never prints a secret, only file paths and hosts.
 *
 * Every path honours the temp-home variables (`CLAUDE_CONFIG_DIR`,
 * `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `CODEX_HOME`, `HOME`), so tests
 * run it against fixture homes and never touch the real machine config.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError } from "../mcp/index.ts";

export interface CliDoctor {
  readonly cli: string;
  readonly version: string | null;
  readonly gateway: "yes" | "no" | "unknown";
  readonly gatewaySource: string | null;
  readonly mcp: "yes" | "no";
  readonly mcpSource: string | null;
  readonly managed: string[];
}

export interface GatewayDoctor {
  readonly baseUrl: string | null;
  readonly reachable: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly at: string;
  readonly gateway: GatewayDoctor;
  readonly clis: CliDoctor[];
}

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  return home !== undefined && home !== "" ? home : homedir();
}

/** Shorten a path for display without leaking anything. */
function show(path: string, home: string): string {
  const short = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return short === "" ? "~" : short;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): unknown | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commandVersion(command: string): string | null {
  try {
    const out = execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split("\n", 1)[0]?.trim() ?? "";
    return first === "" ? "installed" : first;
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Walk a parsed JSON config and collect every MCP server map (`mcpServers` in Claude, `mcp` in OpenCode). */
function collectMcpServers(
  node: unknown,
  into: Array<{ servers: Record<string, unknown>; path: string }>,
  path: string,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectMcpServers(item, into, path);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      (key === "mcpServers" || key === "mcp") &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      into.push({ servers: value as Record<string, unknown>, path });
    } else {
      collectMcpServers(value, into, path);
    }
  }
}

function mcpEntryText(entry: unknown): string {
  try {
    return JSON.stringify(entry) ?? "";
  } catch {
    return "";
  }
}

/** Find a `taa` server entry whose command runs `taa mcp`. */
function findTaaServer(files: ReadonlyArray<{ file: string; json: unknown }>): string | null {
  for (const { file, json } of files) {
    const found: Array<{ servers: Record<string, unknown>; path: string }> = [];
    collectMcpServers(json, found, file);
    for (const group of found) {
      const entry = group.servers.taa;
      if (entry === undefined) continue;
      const text = mcpEntryText(entry);
      if (text.includes("taa") && text.includes("mcp")) return file;
    }
  }
  return null;
}

/** Find a gateway base URL inside a parsed JSON config. */
function findGatewayJson(json: unknown, gatewayHost: string | null): string | null {
  if (gatewayHost === null) return null;
  const text = JSON.stringify(json) ?? "";
  if (!text.includes(gatewayHost)) return null;
  return gatewayHost;
}

function managedPresent(paths: readonly string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

function checkClaude(home: string, env: NodeJS.ProcessEnv, gatewayHost: string | null): CliDoctor {
  const claudeDir =
    env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
      ? env.CLAUDE_CONFIG_DIR
      : join(home, ".claude");
  const settings = [join(claudeDir, "settings.json"), join(home, ".claude", "settings.json")];
  let gateway: CliDoctor["gateway"] = "unknown";
  let gatewaySource: string | null = null;
  for (const file of settings) {
    const json = readJson(file);
    if (json === null || gatewayHost === null) continue;
    if (findGatewayJson(json, gatewayHost) !== null) {
      gateway = "yes";
      gatewaySource = file;
      break;
    }
    gateway = "no";
    gatewaySource = gatewaySource ?? file;
  }
  const mcpFiles = [join(home, ".claude.json"), join(claudeDir, ".claude.json")]
    .map((file) => ({ file, json: readJson(file) }))
    .filter((entry): entry is { file: string; json: unknown } => entry.json !== null);
  for (const file of settings) {
    const json = readJson(file);
    if (json !== null) mcpFiles.push({ file, json });
  }
  const mcpSource = findTaaServer(mcpFiles);
  return {
    cli: "claude",
    version: commandVersion("claude"),
    gateway,
    gatewaySource: gatewaySource === null ? null : gatewaySource,
    mcp: mcpSource === null ? "no" : "yes",
    mcpSource,
    managed: managedPresent([
      "/etc/claude-code/managed-settings.json",
      "/etc/claude-code/managed-mcp.json",
    ]),
  };
}

function checkOpenCode(
  home: string,
  env: NodeJS.ProcessEnv,
  gatewayHost: string | null,
): CliDoctor {
  const candidates: string[] = [];
  const single = env.OPENCODE_CONFIG;
  if (single !== undefined && single !== "") candidates.push(single);
  const dir = env.OPENCODE_CONFIG_DIR;
  candidates.push(
    dir !== undefined && dir !== ""
      ? join(dir, "opencode.json")
      : join(home, ".config", "opencode", "opencode.json"),
  );
  let gateway: CliDoctor["gateway"] = "unknown";
  let gatewaySource: string | null = null;
  const parsed: Array<{ file: string; json: unknown }> = [];
  for (const file of candidates) {
    const json = readJson(file);
    if (json === null) continue;
    parsed.push({ file, json });
    if (gatewayHost === null) continue;
    if (findGatewayJson(json, gatewayHost) !== null) {
      gateway = "yes";
      gatewaySource = file;
    } else if (gateway === "unknown") {
      gateway = "no";
      gatewaySource = file;
    }
  }
  const mcpSource = findTaaServer(parsed);
  return {
    cli: "opencode",
    version: commandVersion("opencode"),
    gateway,
    gatewaySource,
    mcp: mcpSource === null ? "no" : "yes",
    mcpSource,
    managed: managedPresent(["/etc/opencode/opencode.json"]),
  };
}

function checkCodex(home: string, env: NodeJS.ProcessEnv, gatewayHost: string | null): CliDoctor {
  const file =
    env.CODEX_HOME !== undefined && env.CODEX_HOME !== ""
      ? join(env.CODEX_HOME, "config.toml")
      : join(home, ".codex", "config.toml");
  const text = readText(file);
  let gateway: CliDoctor["gateway"] = "unknown";
  if (text !== null && gatewayHost !== null) {
    gateway = text.includes(gatewayHost) ? "yes" : "no";
  }
  const mcp =
    text !== null && /\[mcp_servers\.taa\]/.test(text) && text.includes("taa") ? "yes" : "no";
  return {
    cli: "codex",
    version: commandVersion("codex"),
    gateway,
    gatewaySource: text === null ? null : file,
    mcp,
    mcpSource: mcp === "yes" ? file : null,
    managed: managedPresent(["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"]),
  };
}

async function checkGateway(
  baseUrl: string | null,
  memberKey: string | null,
  managerToken: string | null,
): Promise<GatewayDoctor> {
  if (baseUrl === null) {
    return { baseUrl: null, reachable: false, detail: "TAA_BASE_URL is not set" };
  }
  const auth = memberKey ?? managerToken;
  if (auth !== null) {
    const api = new ApiClient({ baseUrl, auth, timeoutMs: 10_000 });
    try {
      await api.getMe();
      return { baseUrl, reachable: true, detail: "reachable, credential accepted" };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return { baseUrl, reachable: true, detail: "reachable, credential rejected (HTTP 401)" };
      }
      if (error instanceof ApiError && error.isNetwork()) {
        return {
          baseUrl,
          reachable: false,
          detail: "unreachable: connection refused or timed out",
        };
      }
      if (error instanceof ApiError) {
        return { baseUrl, reachable: true, detail: `reachable, answered HTTP ${error.status}` };
      }
      return { baseUrl, reachable: false, detail: "unreachable" };
    }
  }
  try {
    const response = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return { baseUrl, reachable: true, detail: `reachable, answered HTTP ${response.status}` };
  } catch {
    return { baseUrl, reachable: false, detail: "unreachable: connection refused or timed out" };
  }
}

function memberKeyIfPresent(env: NodeJS.ProcessEnv): string | null {
  for (const name of ["TAA_MEMBER_KEY", "TAA_KEY"]) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** Run every check and return the report. Nothing is written. */
export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const home = homeOf(env);
  const rawBase = env.TAA_BASE_URL ?? env.TAA_URL ?? null;
  const gatewayHost = rawBase === null ? null : hostOf(rawBase);
  const gateway = await checkGateway(
    rawBase,
    memberKeyIfPresent(env),
    env.TAA_MANAGER_TOKEN ?? null,
  );
  return {
    at: new Date().toISOString(),
    gateway,
    clis: [
      checkClaude(home, env, gatewayHost),
      checkOpenCode(home, env, gatewayHost),
      checkCodex(home, env, gatewayHost),
    ],
  };
}

/** One line per fact, grouped under the gateway and each CLI. */
export function formatDoctor(report: DoctorReport, env: NodeJS.ProcessEnv = process.env): string {
  const home = homeOf(env);
  const lines: string[] = [];
  const gateway = report.gateway;
  lines.push(
    `gateway ${gateway.baseUrl ?? "(not configured)"}: ${gateway.reachable ? "reachable" : "unreachable"} (${gateway.detail})`,
  );
  for (const cli of report.clis) {
    const version = cli.version ?? "not installed";
    const gatewayText =
      cli.gateway === "unknown"
        ? "gateway unknown"
        : `gateway ${cli.gateway}${cli.gatewaySource === null ? "" : ` (${show(cli.gatewaySource, home)})`}`;
    const mcpText =
      cli.mcp === "yes" && cli.mcpSource !== null
        ? `mcp taa yes (${show(cli.mcpSource, home)})`
        : "mcp taa no";
    const managedText =
      cli.managed.length > 0 ? `managed: ${cli.managed.join(", ")}` : "managed: none";
    lines.push(`${cli.cli} ${version}: ${gatewayText}, ${mcpText}, ${managedText}`);
  }
  return lines.join("\n");
}
