/**
 * Public entry point for the MCP module.
 *
 * Other lanes import from here only, never from a file inside it.
 */

export type {
  ApiClientOptions,
  AuditQuery,
  CreateRequestInput,
  DecideRequestInput,
  MemberDetail,
  SetLimitsInput,
  TeamOverview,
  TeamRequestsFilter,
} from "./api.ts";
export { ApiClient, ApiError, sumSpend } from "./api.ts";
export type { ManagerCredentials, MemberCredentials } from "./config.ts";
export { ConfigError, loadManagerConfig, loadMemberConfig, readSecretFile } from "./config.ts";
export type { HintsFile, ModelHint } from "./hints.ts";
export { defaultHintsPath, findHint, loadHints, parseHintsFile } from "./hints.ts";
export { registerManagerTools } from "./manager-tools.ts";
export { apiFailure, registerMemberTools } from "./member-tools.ts";
export type { McpRole } from "./server.ts";
export { createManagerServer, createMemberServer, parseRole, runMcp } from "./server.ts";
export type { AllowanceView } from "./text.ts";
export {
  allowanceView,
  formatAllowance,
  formatRequests,
  formatUsd,
  summarizeUsage,
} from "./text.ts";
