/**
 * Setup-pack input and output shapes.
 *
 * A setup spec describes one team (gateway, models, MCP server) and one
 * member's enrolment. The member's gateway key is deliberately not part of
 * the spec file: it is passed separately and only ever written to the
 * member's own 0600 environment file.
 */

export class SetupSpecError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "SetupSpecError";
    this.field = field;
  }
}

export interface SetupModel {
  /** Gateway model id. Must match what LiteLLM serves. */
  id: string;
  displayName: string;
}

export interface SetupMcp {
  command: string;
  args: string[];
}

export interface SetupSecurity {
  /** Codex `allowed_approval_policies`; omitted when undefined. */
  allowedApprovalPolicies?: string[];
  /** Codex `allowed_sandbox_modes`; omitted when undefined. */
  allowedSandboxModes?: string[];
}

export interface SetupSpec {
  team: {
    name: string;
    /** Gateway origin, for example `https://ai.example.com`. No `/v1` suffix. */
    gatewayUrl: string;
    /** OpenCode/Codex provider id, for example `team-gateway`. */
    providerId: string;
    /** Default model id; must be one of `models`. */
    defaultModel: string;
    models: SetupModel[];
    /** Control-service base URL written into the member environment. */
    controlUrl: string;
    mcp: SetupMcp;
    /** Absolute path of the OpenCode budget plugin. */
    pluginPath: string | null;
    security: SetupSecurity;
  };
  member: {
    id: string;
    displayName: string;
    email: string | null;
  };
}

export interface GeneratedFile {
  /** Path inside the bundle, always relative and forward-slashed. */
  path: string;
  contents: string;
  /** File mode for the bundle copy. */
  mode: 0o600 | 0o644 | 0o755;
}

export interface InstallEntry {
  source: string;
  target: string;
  mode: "0644";
  owner: "root:root";
}

export interface SetupBundle {
  files: GeneratedFile[];
  install: InstallEntry[];
}
