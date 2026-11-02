/**
 * The mock upstream: a local fake for OpenAI Chat Completions, OpenAI
 * Responses and Anthropic Messages.
 *
 * `startMockUpstream()` binds 127.0.0.1 on a free port for tests.
 * `node src/mock-upstream/main.ts` is the compose container entry point.
 */

export type { MockModel } from "./models.ts";
export {
  DEFAULT_MOCK_MODEL,
  MOCK_MODELS,
  MOCK_TEXT,
  MOCK_USAGE,
  resolveMockModel,
} from "./models.ts";
export type { MockRequestLog, MockUpstream, MockUpstreamOptions } from "./server.ts";
export { startMockUpstream } from "./server.ts";
