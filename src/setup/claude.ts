/**
 * Claude Code managed configuration.
 *
 * Two files, both read from a system directory and not user-overridable:
 * `managed-settings.json` pins the gateway, the model allowlist and the
 * default model; `managed-mcp.json` is the exclusive MCP server set.
 *
 * The gateway key is not written here. Claude Code reads
 * `ANTHROPIC_AUTH_TOKEN` from the member environment.
 */

import type { SetupSpec } from "./types.ts";

export interface ClaudeManagedSettings {
  env: { ANTHROPIC_BASE_URL: string };
  model: string;
  availableModels: string[];
  allowedProviders: ["customEndpoint"];
}

export interface ClaudeManagedMcp {
  mcpServers: Record<
    string,
    { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  >;
}

export function claudeManagedSettings(spec: SetupSpec): ClaudeManagedSettings {
  return {
    env: { ANTHROPIC_BASE_URL: spec.team.gatewayUrl },
    model: spec.team.defaultModel,
    availableModels: spec.team.models.map((model) => model.id),
    allowedProviders: ["customEndpoint"],
  };
}

export function claudeManagedMcp(spec: SetupSpec): ClaudeManagedMcp {
  return {
    mcpServers: {
      taa: {
        type: "stdio",
        command: spec.team.mcp.command,
        args: [...spec.team.mcp.args],
        env: {},
      },
    },
  };
}
