/**
 * Dependencies shared by the route groups.
 *
 * Everything is a port: the HTTP layer never reaches into a store, a gateway
 * or the filesystem itself.
 */

import type {
  Authenticator,
  CredentialStore,
  LoginRateLimiter,
  ManagerTokenStore,
  SessionStore,
} from "../auth/index.ts";
import type { Clock } from "../contracts.ts";
import type { ApiConfig } from "./config.ts";
import type { ControlPort } from "./control.ts";

export interface ApiDependencies {
  control: ControlPort;
  authenticator: Authenticator;
  credentials: CredentialStore;
  managerTokens: ManagerTokenStore;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  clock: Clock;
  config: ApiConfig;
}
