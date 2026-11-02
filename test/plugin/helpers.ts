/**
 * Test harness for the OpenCode plugin. Not a test file itself.
 *
 * Everything is in-process: a fake event stream, a fake OpenCode client, a
 * fake control-service fetch, and a controllable clock. No test reaches the
 * network.
 */

import {
  createPlugin,
  type EventLike,
  type Hooks,
  type PluginClientLike,
  type TextPartLike,
  type ToolAfterOutput,
} from "../../src/plugin/team-ai-allowance.ts";

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(iso: string): void;
}

export function fakeClock(start: string): FakeClock {
  let current = Date.parse(start);
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (iso) => {
      current = Date.parse(iso);
    },
  };
}

export interface RecordedPrompt {
  readonly sessionID: string;
  readonly text: string;
  readonly noReply: boolean;
}

export interface FakeClient {
  readonly client: PluginClientLike;
  readonly prompts: RecordedPrompt[];
  readonly aborts: string[];
  readonly toasts: string[];
}

export function fakeClient(): FakeClient {
  const prompts: RecordedPrompt[] = [];
  const aborts: string[] = [];
  const toasts: string[] = [];
  const client: PluginClientLike = {
    session: {
      prompt: async (input) => {
        prompts.push({
          sessionID: input.path.id,
          text: input.body.parts.map((part) => part.text).join(""),
          noReply: input.body.noReply === true,
        });
        return {};
      },
      abort: async (input) => {
        aborts.push(input.path.id);
        return true;
      },
    },
    tui: {
      showToast: async (input) => {
        toasts.push(input.body.message);
        return {};
      },
    },
  };
  return { client, prompts, aborts, toasts };
}

export interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export interface FetchStub {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
  readonly paths: string[];
}

/** A fetch stub keyed by pathname. Unmatched paths answer 404. */
export function fetchStub(routes: Record<string, FetchHandler>): FetchStub {
  const calls: FetchCall[] = [];
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const authorization =
      init?.headers !== undefined ? new Headers(init.headers).get("authorization") : null;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url,
      body,
      authorization,
    };
    calls.push(call);
    paths.push(parsed.pathname);
    const handler = routes[parsed.pathname];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls, paths };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function policyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    budget: { limitUsd: 1, spentUsd: 0, warnRatios: [0.5, 0.8], stopRatio: 1 },
    unattended: {
      workingHours: {
        timeZone: "Europe/Berlin",
        workingDays: [1, 2, 3, 4, 5],
        startMinute: 7 * 60,
        endMinute: 19 * 60,
        holidays: [],
      },
      working: { maxMinutes: 30, maxSteps: 40 },
      offHours: { maxMinutes: 10, maxSteps: 15 },
    },
    loop: { sameToolArgs: 5, sameError: 3 },
    softLimit: { ratio: 0.8 },
    ...overrides,
  };
}

export interface Harness {
  readonly hooks: Hooks;
  readonly controller: ReturnType<typeof createPlugin>;
  readonly client: FakeClient;
  readonly clock: FakeClock;
  readonly stateDir: string;
  readonly fetch: FetchStub;
  assistant(sessionID: string, id: string, cost: number, completed?: boolean): Promise<void>;
  user(sessionID: string, text?: string, synthetic?: boolean): Promise<void>;
  before(sessionID: string, tool: string, args?: unknown): Promise<void>;
  after(
    sessionID: string,
    tool: string,
    output: string | ToolAfterOutput,
    args?: unknown,
  ): Promise<void>;
  event(event: EventLike): Promise<void>;
}

export interface HarnessOptions {
  readonly start?: string;
  readonly stateDir: string;
  readonly routes?: Record<string, FetchHandler>;
  readonly env?: Record<string, string | undefined>;
}

export function harness(options: HarnessOptions): Harness {
  const clock = fakeClock(options.start ?? "2026-10-27T09:00:00Z");
  const client = fakeClient();
  const fetch =
    options.routes === undefined
      ? fetchStub({ "/api/me/session-policy": () => jsonResponse(policyPayload()) })
      : fetchStub(options.routes);
  const controller = createPlugin(
    { client: client.client },
    {
      now: clock.now,
      stateDir: options.stateDir,
      baseUrl: "http://127.0.0.1:1",
      key: "test-member-key",
      fetchImpl: fetch.fetchImpl,
      env: options.env ?? {},
      logger: { warn: () => undefined },
    },
  );
  const hooks = controller.hooks();
  const sessionDefault = "ses_test";

  const assistant = async (
    sessionID: string,
    id: string,
    cost: number,
    completed = true,
  ): Promise<void> => {
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id,
            sessionID,
            role: "assistant",
            time: completed
              ? { created: clock.now(), completed: clock.now() }
              : { created: clock.now() },
            cost,
          },
        },
      },
    });
  };

  return {
    hooks,
    controller,
    client,
    clock,
    stateDir: options.stateDir,
    fetch,
    assistant,
    user: async (sessionID, text = "please continue", synthetic = false) => {
      const parts: TextPartLike[] = [{ type: "text", text, synthetic }];
      await hooks["chat.message"]?.({ sessionID }, { message: { role: "user", sessionID }, parts });
    },
    before: async (sessionID = sessionDefault, tool = "bash", args = { command: "ls" }) => {
      await hooks["tool.execute.before"]?.({ tool, sessionID, callID: "call" }, { args });
    },
    after: async (sessionID, tool, output, args = {}) => {
      const value: ToolAfterOutput = typeof output === "string" ? { output } : output;
      await hooks["tool.execute.after"]?.({ tool, sessionID, callID: "call", args }, value);
    },
    event: async (event) => {
      await hooks.event?.({ event });
    },
  };
}
