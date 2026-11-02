/**
 * Assemble a complete setup bundle.
 *
 * The bundle is the unit an administrator copies to a machine: managed
 * files, the member environment file, MDM templates, and an install plan.
 * Generation is deterministic, so two runs on the same spec are identical.
 */

import { claudeManagedMcp, claudeManagedSettings } from "./claude.ts";
import { codexManagedConfig, codexRequirements } from "./codex.ts";
import { claudeProfile, codexProfile, openCodeProfile } from "./mdm.ts";
import { memberEnvFile } from "./member.ts";
import { openCodeConfig } from "./opencode.ts";
import {
  CLAUDE_MCP,
  CLAUDE_SETTINGS,
  CODEX_MANAGED_CONFIG,
  CODEX_REQUIREMENTS,
  MEMBER_ENV_TARGET,
  OPENCODE_CONFIG,
} from "./paths.ts";
import { assertEnvSafeKey } from "./spec.ts";
import {
  type GeneratedFile,
  type InstallEntry,
  type SetupBundle,
  type SetupSpec,
  SetupSpecError,
} from "./types.ts";

const GENERATOR = "team-ai-allowance setup-pack 1";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNoWhitespace(path: string): string {
  if (/\s/.test(path)) throw new SetupSpecError("bundle", `path contains whitespace: ${path}`);
  return path;
}

export interface ManagedFile {
  source: string;
  contents: string;
  targets: { linux: string; macos: string | null };
}

export function managedFiles(spec: SetupSpec): ManagedFile[] {
  return [
    {
      source: "managed/claude-code/managed-settings.json",
      contents: json(claudeManagedSettings(spec)),
      targets: CLAUDE_SETTINGS,
    },
    {
      source: "managed/claude-code/managed-mcp.json",
      contents: json(claudeManagedMcp(spec)),
      targets: CLAUDE_MCP,
    },
    {
      source: "managed/opencode/opencode.json",
      contents: json(openCodeConfig(spec)),
      targets: OPENCODE_CONFIG,
    },
    {
      source: "managed/codex/requirements.toml",
      contents: codexRequirements(spec),
      targets: CODEX_REQUIREMENTS,
    },
    {
      source: "managed/codex/managed_config.toml",
      contents: codexManagedConfig(spec),
      targets: CODEX_MANAGED_CONFIG,
    },
  ];
}

export function generateSetupBundle(spec: SetupSpec, memberKey: string): SetupBundle {
  const key = assertEnvSafeKey(memberKey);
  const managed = managedFiles(spec);
  const memberEnv = memberEnvFile(spec, key);

  const files: GeneratedFile[] = [
    ...managed.map((file) => ({
      path: file.source,
      contents: file.contents,
      mode: 0o644 as const,
    })),
    { path: "member/taa.env", contents: memberEnv, mode: 0o600 as const },
    {
      path: "mdm/com.anthropic.claudecode.mobileconfig",
      contents: claudeProfile(spec),
      mode: 0o644,
    },
    { path: "mdm/ai.opencode.managed.mobileconfig", contents: openCodeProfile(spec), mode: 0o644 },
    { path: "mdm/com.openai.codex.mobileconfig", contents: codexProfile(spec), mode: 0o644 },
  ];

  const install: InstallEntry[] = managed.map((file) => ({
    source: assertNoWhitespace(file.source),
    target: assertNoWhitespace(file.targets.linux),
    mode: "0644",
    owner: "root:root",
  }));

  files.push({
    path: "install.txt",
    contents: `${install
      .map((entry) => `${entry.mode} ${entry.owner} ${entry.source} ${entry.target}`)
      .join("\n")}\n`,
    mode: 0o644,
  });

  files.push({
    path: "manifest.json",
    contents: json({
      format: 1,
      generator: GENERATOR,
      team: spec.team.name,
      member: { id: spec.member.id, displayName: spec.member.displayName },
      gatewayUrl: spec.team.gatewayUrl,
      providerId: spec.team.providerId,
      defaultModel: spec.team.defaultModel,
      models: spec.team.models.map((model) => model.id),
      managed: managed.map((file) => ({
        source: file.source,
        targets: { linux: file.targets.linux, macos: file.targets.macos },
      })),
      memberEnv: { source: "member/taa.env", target: MEMBER_ENV_TARGET, mode: "0600" },
      mdm: [
        "mdm/com.anthropic.claudecode.mobileconfig",
        "mdm/ai.opencode.managed.mobileconfig",
        "mdm/com.openai.codex.mobileconfig",
      ],
    }),
    mode: 0o644,
  });

  // Defence in depth: the enrolment key must appear only in the member env.
  for (const file of files) {
    if (file.path === "member/taa.env") continue;
    if (file.contents.includes(key)) {
      throw new SetupSpecError("memberKey", `leaked into generated file ${file.path}`);
    }
  }

  return { files, install };
}
