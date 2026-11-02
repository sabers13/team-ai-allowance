/**
 * The gateway client's only environment reader.
 *
 * `TAA_GATEWAY_URL` is the LiteLLM base URL (default `http://127.0.0.1:14000`,
 * the compose gateway port). `LITELLM_MASTER_KEY` is the admin key; it is read
 * here, passed to the client and never printed, logged or included in an error.
 */
import { GatewayConfigError } from "./errors.ts";

export interface GatewayConfig {
  readonly baseUrl: string;
  readonly masterKey: string;
  readonly timeoutMs: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:14000";
const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GatewayConfigError("TAA_GATEWAY_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayConfigError("TAA_GATEWAY_URL must be an http or https URL");
  }
  return trimmed;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const masterKey = env.LITELLM_MASTER_KEY?.trim() ?? "";
  if (masterKey.length === 0) {
    throw new GatewayConfigError("LITELLM_MASTER_KEY is not set");
  }
  if (!masterKey.startsWith("sk-")) {
    throw new GatewayConfigError("LITELLM_MASTER_KEY must start with sk-");
  }

  const rawTimeout = env.TAA_GATEWAY_TIMEOUT_MS?.trim();
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === ""
      ? DEFAULT_TIMEOUT_MS
      : Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayConfigError("TAA_GATEWAY_TIMEOUT_MS must be a positive integer");
  }

  return {
    baseUrl: normalizeBaseUrl(env.TAA_GATEWAY_URL ?? DEFAULT_BASE_URL),
    masterKey,
    timeoutMs,
  };
}
