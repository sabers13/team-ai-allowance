/**
 * Public entry point for `src/server/`.
 *
 * `taa serve` builds one `ControlServerHandle` from a `ServerConfig`; the e2e
 * harness and `scripts/demo.ts` build the same thing in-process.
 */

export type { BootstrapSettings, GatewaySettings, ServerConfig } from "./config.ts";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  loadServerConfig,
  ServerConfigError,
} from "./config.ts";
export type { ConsolePorts, ConsoleWiringDeps } from "./console.ts";
export { createConsolePorts, parseCookies, resolveConsoleSession, viewerOf } from "./console.ts";
export type { ControlPortDeps, ControlPortWithKeys } from "./control.ts";
export { createControlPort, DECISION_OUTCOMES, DEFAULT_LIMITS } from "./control.ts";
export type { DemoSeedOptions, DemoSeedResult } from "./demo.ts";
export {
  DEMO_ADMIN_ID,
  DEMO_MANAGER_ID,
  DEMO_MODEL_IDS,
  DEMO_TEAM_ID,
  DEMO_TEAM_NAME,
  demoModels,
  demoPolicy,
  seedDemo,
} from "./demo.ts";
export type { ControlServerHandle, ControlServerOptions } from "./serve.ts";
export { createControlServer } from "./serve.ts";
