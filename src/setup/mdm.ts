/**
 * macOS MDM `.mobileconfig` templates.
 *
 * A profile is a plist wrapper around one managed-preferences payload. The
 * domains are the ones the vendors document:
 *
 * - Claude Code: `com.anthropic.claudecode`, keys shaped like
 *   `managed-settings.json`.
 * - OpenCode: `ai.opencode.managed`, keys shaped like `opencode.json`.
 * - Codex: `com.openai.codex`, `config_toml_base64` and
 *   `requirements_toml_base64`.
 *
 * These are templates: they are generated from the same spec as the Linux
 * files, but only the Linux path is proven in the container check.
 */

import { createHash } from "node:crypto";
import { claudeManagedSettings } from "./claude.ts";
import { codexManagedConfig, codexRequirements } from "./codex.ts";
import { openCodeConfig } from "./opencode.ts";
import { openAiBaseUrl } from "./spec.ts";
import type { SetupSpec } from "./types.ts";

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plist(value: PlistValue, indent: number): string {
  const pad = "  ".repeat(indent);
  if (typeof value === "string") return `${pad}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${pad}<${value ? "true" : "false"}/>`;
  if (typeof value === "number") return `${pad}<integer>${String(value)}</integer>`;
  if (Array.isArray(value)) {
    const body = value.map((entry) => plist(entry, indent + 1)).join("\n");
    return `${pad}<array>\n${body}\n${pad}</array>`;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => `${pad}  <key>${escapeXml(key)}</key>\n${plist(entry, indent + 1)}`)
    .join("\n");
  return `${pad}<dict>\n${entries}\n${pad}</dict>`;
}

/** A stable UUID per profile so regenerating does not churn the MDM. */
function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

function profile(options: {
  domain: string;
  displayName: string;
  organization: string;
  seed: string;
  settings: PlistValue;
}): string {
  const payloadUuid = stableUuid(`${options.seed}:payload`);
  const profileUuid = stableUuid(`${options.seed}:profile`);
  const identifier = `com.team-ai-allowance.${options.domain}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>PayloadContent</key>",
    "  <array>",
    "    <dict>",
    "      <key>PayloadType</key>",
    `      <string>${escapeXml(options.domain)}</string>`,
    "      <key>PayloadIdentifier</key>",
    `      <string>${escapeXml(`${identifier}.settings`)}</string>`,
    "      <key>PayloadUUID</key>",
    `      <string>${payloadUuid}</string>`,
    "      <key>PayloadVersion</key>",
    "      <integer>1</integer>",
    "      <key>PayloadDisplayName</key>",
    `      <string>${escapeXml(options.displayName)} settings</string>`,
    plist(options.settings, 3),
    "    </dict>",
    "  </array>",
    "  <key>PayloadType</key>",
    "  <string>Configuration</string>",
    "  <key>PayloadIdentifier</key>",
    `  <string>${escapeXml(identifier)}</string>`,
    "  <key>PayloadUUID</key>",
    `  <string>${profileUuid}</string>`,
    "  <key>PayloadVersion</key>",
    "  <integer>1</integer>",
    "  <key>PayloadDisplayName</key>",
    `  <string>${escapeXml(options.displayName)}</string>`,
    "  <key>PayloadOrganization</key>",
    `  <string>${escapeXml(options.organization)}</string>`,
    "  <key>PayloadRemovalDisallowed</key>",
    "  <false/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function claudeProfile(spec: SetupSpec): string {
  const settings = claudeManagedSettings(spec);
  return profile({
    domain: "com.anthropic.claudecode",
    displayName: "Claude Code gateway policy",
    organization: spec.team.name,
    seed: `${spec.team.name}:${spec.member.id}:claude`,
    settings: {
      env: settings.env,
      model: settings.model,
      availableModels: settings.availableModels,
      allowedProviders: [...settings.allowedProviders],
    },
  });
}

export function openCodeProfile(spec: SetupSpec): string {
  const config = openCodeConfig(spec);
  const models: { [key: string]: PlistValue } = {};
  for (const model of spec.team.models) models[model.id] = { name: model.displayName };
  const payload: { [key: string]: PlistValue } = {
    model: config.model,
    enabled_providers: [spec.team.providerId],
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
    mcp: {
      taa: {
        type: "local",
        command: [spec.team.mcp.command, ...spec.team.mcp.args],
        environment: { TAA_MEMBER_KEY: "{env:TAA_MEMBER_KEY}" },
        enabled: true,
      },
    },
  };
  if (spec.team.pluginPath !== null) payload.plugin = [spec.team.pluginPath];
  return profile({
    domain: "ai.opencode.managed",
    displayName: "OpenCode gateway policy",
    organization: spec.team.name,
    seed: `${spec.team.name}:${spec.member.id}:opencode`,
    settings: payload,
  });
}

export function codexProfile(spec: SetupSpec): string {
  return profile({
    domain: "com.openai.codex",
    displayName: "Codex gateway policy",
    organization: spec.team.name,
    seed: `${spec.team.name}:${spec.member.id}:codex`,
    settings: {
      config_toml_base64: Buffer.from(codexManagedConfig(spec), "utf8").toString("base64"),
      requirements_toml_base64: Buffer.from(codexRequirements(spec), "utf8").toString("base64"),
    },
  });
}
