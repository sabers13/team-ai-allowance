/**
 * Public entry point for the gateway module.
 *
 * Other lanes import from here only. They get the frozen `GatewayClient`
 * implementation, the typed errors and the environment loader.
 */

export type { LiteLLMGatewayClientOptions } from "./client.ts";
export { LiteLLMGatewayClient, toTeamRole } from "./client.ts";
export type { GatewayConfig } from "./config.ts";
export { loadGatewayConfig } from "./config.ts";
export type { GatewayErrorCode, GatewayErrorOptions } from "./errors.ts";
export {
  GatewayConfigError,
  GatewayError,
  mapHttpError,
  readErrorEnvelope,
  redactSecrets,
} from "./errors.ts";
export type {
  CreateUserInput,
  KeyRecord,
  TeamMemberPatch,
  TeamRecord,
  TeamSpendRow,
  UpdateUserPatch,
  UserRecord,
} from "./types.ts";

import type { GatewayClient } from "../contracts.ts";
import { LiteLLMGatewayClient } from "./client.ts";
import { loadGatewayConfig } from "./config.ts";

/** Build a client from `TAA_GATEWAY_URL` and `LITELLM_MASTER_KEY`. */
export function createGatewayClientFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayClient {
  const config = loadGatewayConfig(env);
  return new LiteLLMGatewayClient({
    baseUrl: config.baseUrl,
    masterKey: config.masterKey,
    timeoutMs: config.timeoutMs,
  });
}
