/**
 * OpenCode managed configuration.
 *
 * `/etc/opencode/opencode.json` is the highest-precedence config source.
 * `enabled_providers` with a single id compiles to a deny-all / allow-gateway
 * policy pair in OpenCode 2, so a user's own provider entries cannot be used.
 * The key is referenced as `{env:TAA_MEMBER_KEY}` and never written here.
 */

import { openAiBaseUrl } from "./spec.ts";
import type { SetupSpec } from "./types.ts";

export interface OpenCodeConfig {
  $schema: string;
  provider: Record<
    string,
    {
      npm: string;
      name: string;
      options: { baseURL: string; apiKey: string };
      models: Record<string, { name: string }>;
    }
  >;
  model: string;
  enabled_providers: string[];
  mcp: Record<
    string,
    {
      type: "local";
      command: string[];
      environment: Record<string, string>;
      enabled: boolean;
    }
  >;
  plugin?: string[];
}

export function openCodeConfig(spec: SetupSpec): OpenCodeConfig {
  const models: Record<string, { name: string }> = {};
  for (const model of spec.team.models) models[model.id] = { name: model.displayName };

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [spec.team.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `Team gateway (${spec.team.name})`,
        options: {
          baseURL: openAiBaseUrl(spec.team.gatewayUrl),
          apiKey: "{env:TAA_MEMBER_KEY}",
        },
        models,
      },
    },
    model: `${spec.team.providerId}/${spec.team.defaultModel}`,
    enabled_providers: [spec.team.providerId],
    mcp: {
      taa: {
        type: "local",
        command: [spec.team.mcp.command, ...spec.team.mcp.args],
        environment: { TAA_MEMBER_KEY: "{env:TAA_MEMBER_KEY}" },
        enabled: true,
      },
    },
    ...(spec.team.pluginPath === null ? {} : { plugin: [spec.team.pluginPath] }),
  };
}
