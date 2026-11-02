/**
 * Where each generated managed file goes.
 *
 * Linux paths are the ones the container check proves. macOS paths are the
 * file-based alternative to the generated MDM profiles.
 */

export interface ManagedTargets {
  linux: string;
  macos: string | null;
}

export const CLAUDE_SETTINGS: ManagedTargets = {
  linux: "/etc/claude-code/managed-settings.json",
  macos: "/Library/Application Support/ClaudeCode/managed-settings.json",
};

export const CLAUDE_MCP: ManagedTargets = {
  linux: "/etc/claude-code/managed-mcp.json",
  macos: "/Library/Application Support/ClaudeCode/managed-mcp.json",
};

export const OPENCODE_CONFIG: ManagedTargets = {
  linux: "/etc/opencode/opencode.json",
  macos: "/Library/Application Support/opencode/opencode.json",
};

export const CODEX_REQUIREMENTS: ManagedTargets = {
  linux: "/etc/codex/requirements.toml",
  macos: null,
};

export const CODEX_MANAGED_CONFIG: ManagedTargets = {
  linux: "/etc/codex/managed_config.toml",
  macos: null,
};

/** The member env file is not installed as root; the member copies it. */
export const MEMBER_ENV_TARGET = "~/.config/team-ai-allowance/env";
