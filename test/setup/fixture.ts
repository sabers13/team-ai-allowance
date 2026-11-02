/**
 * Shared fixtures for the setup-pack tests.
 *
 * The gateway key is an inert string: these tests check plumbing, never a
 * live credential.
 */

import { parseSetupSpec } from "../../src/setup/index.ts";

export const KEY = "inert-key-0001";

export function spec() {
  return parseSetupSpec({
    team: {
      name: "Demo Works",
      gatewayUrl: "https://gateway.example.com/",
      providerId: "team-gateway",
      defaultModel: "model-a",
      models: [
        { id: "model-a", displayName: "Model A" },
        { id: "model-b", displayName: "Model B" },
      ],
      controlUrl: "https://allowance.example.com",
      mcp: { command: "taa", args: ["mcp"] },
      pluginPath: "/etc/opencode/plugins/team-ai-allowance.ts",
      security: {
        allowedApprovalPolicies: ["on-request"],
        allowedSandboxModes: ["read-only", "workspace-write"],
      },
    },
    member: {
      id: "mbr_demo",
      displayName: "Ada",
      email: "ada@example.com",
    },
  });
}

/** The same spec without optional fields. */
export function minimalSpec() {
  return parseSetupSpec({
    team: {
      name: "Minimal",
      gatewayUrl: "http://127.0.0.1:4000",
      providerId: "gw",
      defaultModel: "m",
      models: [{ id: "m", displayName: "M" }],
      controlUrl: "http://127.0.0.1:8080",
      mcp: { command: "taa", args: [] },
    },
    member: { id: "mbr_min", displayName: "Bo", email: null },
  });
}
