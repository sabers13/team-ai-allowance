/**
 * The fake models the mock upstream serves.
 *
 * The ids are intentionally unlikely to collide with a real provider name, so a
 * test that accidentally points at a real gateway fails instead of spending
 * money. `deploy/litellm.config.yaml` routes every one of them here.
 */

/** The model ids the mock upstream offers. */
export const MOCK_MODELS = ["mock-cheap", "mock-flagship"] as const;

export type MockModel = (typeof MOCK_MODELS)[number];

export const DEFAULT_MOCK_MODEL: MockModel = "mock-cheap";

/**
 * Fixed usage for every request, so a test can predict cost exactly.
 *
 * A cost assertion multiplies these numbers by the per-token price in
 * `deploy/litellm.config.yaml`; the total never depends on the request body,
 * the number of prior calls or the streaming mode.
 */
export const MOCK_USAGE = {
  promptTokens: 12,
  completionTokens: 7,
  totalTokens: 19,
} as const;

/** The only assistant text the fake ever returns. */
export const MOCK_TEXT = "mock response";

/** Echo a requested model when it is a string, otherwise use the default. */
export function resolveMockModel(requested: unknown): string {
  if (typeof requested === "string" && requested.length > 0 && requested.length <= 200) {
    return requested;
  }
  return DEFAULT_MOCK_MODEL;
}
