/**
 * The per-member environment bundle.
 *
 * The gateway key lives here and only here. Managed files reference
 * `TAA_MEMBER_KEY` by name, so a managed file never contains the secret and
 * can be committed, copied between machines, or read by another local user.
 * The caller writes this file with mode 0600.
 */

import { assertEnvSafeKey } from "./spec.ts";
import type { SetupSpec } from "./types.ts";

export function memberEnvFile(spec: SetupSpec, memberKey: string): string {
  const key = assertEnvSafeKey(memberKey);
  return [
    `# Team AI allowance: member environment for ${spec.member.displayName}`,
    "# Mode 0600. Holds a gateway key: never commit, paste or share this file.",
    `# Team: ${spec.team.name}`,
    `# Claude Code reads ANTHROPIC_BASE_URL from managed-settings.json, but the`,
    "# base URL is repeated here so a shell without managed config still works.",
    `export ANTHROPIC_BASE_URL=${spec.team.gatewayUrl}`,
    `export ANTHROPIC_AUTH_TOKEN=${key}`,
    `export TAA_MEMBER_KEY=${key}`,
    `export TAA_BASE_URL=${spec.team.controlUrl}`,
    "",
  ].join("\n");
}
