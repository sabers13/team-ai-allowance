/**
 * Validation for a setup spec. Hand-written so every message names the JSON
 * field a person has to fix. The gateway key never appears here.
 */

import { readFile } from "node:fs/promises";
import {
  type SetupMcp,
  type SetupModel,
  type SetupSecurity,
  type SetupSpec,
  SetupSpecError,
} from "./types.ts";

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupSpecError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SetupSpecError(field, "must be a non-empty string");
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field);
}

function absoluteUrl(value: unknown, field: string): string {
  const raw = text(value, field).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SetupSpecError(field, "must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SetupSpecError(field, "must be an absolute http(s) URL");
  }
  return raw;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new SetupSpecError(field, "must be an array of strings");
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function models(value: unknown): SetupModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SetupSpecError("team.models", "must list at least one model");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = object(entry, `team.models[${index}]`);
    const id = text(item.id, `team.models[${index}].id`);
    if (seen.has(id)) throw new SetupSpecError(`team.models[${index}].id`, `duplicate model ${id}`);
    seen.add(id);
    return { id, displayName: text(item.displayName, `team.models[${index}].displayName`) };
  });
}

function mcp(value: unknown): SetupMcp {
  const item = object(value, "team.mcp");
  const command = text(item.command, "team.mcp.command");
  const args = item.args;
  if (!Array.isArray(args))
    throw new SetupSpecError("team.mcp.args", "must be an array of strings");
  return {
    command,
    args: args.map((arg, index) => text(arg, `team.mcp.args[${index}]`)),
  };
}

function security(value: unknown): SetupSecurity {
  if (value === undefined || value === null) return {};
  const item = object(value, "team.security");
  return {
    ...(item.allowedApprovalPolicies === undefined
      ? {}
      : {
          allowedApprovalPolicies: stringList(
            item.allowedApprovalPolicies,
            "team.security.allowedApprovalPolicies",
          ),
        }),
    ...(item.allowedSandboxModes === undefined
      ? {}
      : {
          allowedSandboxModes: stringList(
            item.allowedSandboxModes,
            "team.security.allowedSandboxModes",
          ),
        }),
  };
}

/** Validate an already-parsed JSON value as a setup spec. */
export function parseSetupSpec(value: unknown): SetupSpec {
  const root = object(value, "spec");
  const team = object(root.team, "team");
  const member = object(root.member, "member");

  const providerId = text(team.providerId, "team.providerId");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new SetupSpecError(
      "team.providerId",
      "must be lowercase letters, digits, dot, underscore or dash",
    );
  }

  const modelList = models(team.models);
  const defaultModel = text(team.defaultModel, "team.defaultModel");
  if (!modelList.some((model) => model.id === defaultModel)) {
    throw new SetupSpecError("team.defaultModel", "must be one of team.models[].id");
  }

  const pluginPath = optionalText(team.pluginPath, "team.pluginPath");
  if (pluginPath !== null && !pluginPath.startsWith("/")) {
    throw new SetupSpecError("team.pluginPath", "must be an absolute path");
  }

  return {
    team: {
      name: text(team.name, "team.name"),
      gatewayUrl: absoluteUrl(team.gatewayUrl, "team.gatewayUrl"),
      providerId,
      defaultModel,
      models: modelList,
      controlUrl: absoluteUrl(team.controlUrl, "team.controlUrl"),
      mcp: mcp(team.mcp),
      pluginPath,
      security: security(team.security),
    },
    member: {
      id: text(member.id, "member.id"),
      displayName: text(member.displayName, "member.displayName"),
      email: optionalText(member.email, "member.email"),
    },
  };
}

/** Read and validate a setup spec file. The file never holds the key. */
export async function loadSetupSpec(path: string): Promise<SetupSpec> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new SetupSpecError("spec", `cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SetupSpecError(
      "spec",
      `invalid JSON: ${error instanceof Error ? error.message : ""}`,
    );
  }
  return parseSetupSpec(parsed);
}

/**
 * The OpenAI-compatible route suffix. OpenCode and Codex take `/v1` in their
 * base URL; Claude Code takes the gateway root.
 */
export function openAiBaseUrl(gatewayUrl: string): string {
  return gatewayUrl.endsWith("/v1") ? gatewayUrl : `${gatewayUrl}/v1`;
}

/** Reject a gateway key that would break the shell-sourceable env file. */
export function assertEnvSafeKey(key: string): string {
  if (!/^[A-Za-z0-9._~+/=:-]+$/.test(key)) {
    throw new SetupSpecError("memberKey", "contains characters that are unsafe in an env file");
  }
  return key;
}
