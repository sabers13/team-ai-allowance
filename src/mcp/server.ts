/**
 * Stdio MCP servers for the member desk and the manager desk.
 *
 * `taa mcp --role member` serves the seven member tools with the member
 * key from `TAA_MEMBER_KEY` (or `TAA_KEY`) or its `*_FILE` form.
 * `taa mcp --role manager` serves the manager tools with `TAA_MANAGER_TOKEN`.
 * The process owns no listener; stdout is the protocol channel, so every
 * diagnostic goes to stderr and the process exits non-zero on bad config.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ApiClient } from "./api.ts";
import { ConfigError, loadManagerConfig, loadMemberConfig } from "./config.ts";
import { type HintsFile, loadHints } from "./hints.ts";
import { registerManagerTools } from "./manager-tools.ts";
import { registerMemberTools } from "./member-tools.ts";

export type McpRole = "member" | "manager";

const VERSION = "1.0.0";

/** Parse `--role member|manager` (default `member`) from argv. */
export function parseRole(argv: readonly string[]): McpRole {
  const flag = argv.indexOf("--role");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) return "member";
  if (value === "member" || value === "manager") return value;
  throw new ConfigError(`unknown --role "${value}"; want member or manager`);
}

/** Build a member-desk server over any API client (a fake in tests). */
export function createMemberServer(api: ApiClient, hints?: HintsFile): McpServer {
  const server = new McpServer({ name: "taa-member", version: VERSION });
  registerMemberTools(server, { api, hints });
  return server;
}

/** Build a manager-desk server over any API client (a fake in tests). */
export function createManagerServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: "taa-manager", version: VERSION });
  registerManagerTools(server, api);
  return server;
}

/**
 * Read config from the environment, build the API client and serve one
 * connection on stdio until the client closes stdin.
 */
export async function runMcp(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const role = parseRole(argv);
  if (role === "manager") {
    const config = await loadManagerConfig(env);
    const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.token });
    serveStdio(() => createManagerServer(api));
    return;
  }
  const config = await loadMemberConfig(env);
  const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.key });
  const hints = await loadHints(undefined, env);
  serveStdio(() => createMemberServer(api, hints));
}
