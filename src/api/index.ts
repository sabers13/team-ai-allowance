/**
 * Public entry point for `src/api/`.
 *
 * `taa serve` wires `createApiServer` with the SQLite store, control service
 * and gateway. Other lanes import only this file.
 */

export type {
  ApiConfig,
  ApiConfigInput,
} from "./config.ts";
export {
  createApiConfig,
  DEFAULT_PUBLIC_URL,
  loadApiConfig,
} from "./config.ts";
export type {
  Actor,
  ConfigBundle,
  ConfigBundleFile,
  ControlPort,
  CreatedMember,
  CreateMemberInput,
  CreateRequestInput,
  DecideRequestInput,
  DecisionResult,
  LimitsPatch,
  MemberDetail,
  MeView,
  RecordAuditInput,
  RotatedKey,
  TeamAlert,
  TeamOverview,
  TeamOverviewMember,
} from "./control.ts";
export { stubConfigBundle } from "./enrolment.ts";
export type { ApiErrorCode, ErrorEnvelope } from "./errors.ts";
export { ApiError, asApiError, errorEnvelope } from "./errors.ts";
export { actorOf, scopedTeamId } from "./guard.ts";
export type { PublicMember, PublicMemberDetail, PublicTeamOverview } from "./redact.ts";
export { publicMember, publicMemberDetail, publicMembers, publicTeamOverview } from "./redact.ts";
export type { AuthLevel, RequestContext, RouteHandler, RouteResult } from "./router.ts";
export { Router } from "./router.ts";
export { buildRouter } from "./routes/index.ts";
export type { ApiLogEntry, ApiLogger, ApiServerHandle, ApiServerOptions } from "./server.ts";
export { createApiServer, currentClock, silentLogger } from "./server.ts";
