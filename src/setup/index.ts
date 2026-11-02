/**
 * Public entry point for the setup module.
 *
 * Other lanes import from here only, never from a file inside it.
 */

export { generateSetupBundle, type ManagedFile, managedFiles } from "./bundle.ts";
export {
  type ClaudeManagedMcp,
  type ClaudeManagedSettings,
  claudeManagedMcp,
  claudeManagedSettings,
} from "./claude.ts";
export { codexManagedConfig, codexRequirements, tomlString } from "./codex.ts";
export { claudeProfile, codexProfile, openCodeProfile } from "./mdm.ts";
export { memberEnvFile } from "./member.ts";
export { type OpenCodeConfig, openCodeConfig } from "./opencode.ts";
export {
  CLAUDE_MCP,
  CLAUDE_SETTINGS,
  CODEX_MANAGED_CONFIG,
  CODEX_REQUIREMENTS,
  MEMBER_ENV_TARGET,
  OPENCODE_CONFIG,
} from "./paths.ts";
export { assertEnvSafeKey, loadSetupSpec, openAiBaseUrl, parseSetupSpec } from "./spec.ts";
export type {
  GeneratedFile,
  InstallEntry,
  SetupBundle,
  SetupMcp,
  SetupModel,
  SetupSecurity,
  SetupSpec,
} from "./types.ts";
export { SetupSpecError } from "./types.ts";
export { BundleWriteError, type WriteOptions, writeSetupBundle } from "./write.ts";
