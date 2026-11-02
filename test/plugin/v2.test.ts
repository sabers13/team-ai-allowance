/**
 * v2 file-plugin entry (OpenCode 2.x): the unattended step limit pauses a
 * looping run, the run is interrupted, and the session can resume.
 *
 * The loader only accepts `export default { id, setup }`, so this exercises
 * the adapter in `src/plugin/team-ai-allowance.ts` with a fake v2 context.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  setupV2Plugin,
  type V2PluginContext,
  type V2ToolAfterInput,
  type V2ToolBeforeInput,
} from "../../src/plugin/team-ai-allowance.ts";
import { type FetchStub, fetchStub, jsonResponse, policyPayload } from "./helpers.ts";

const STATE_DIRS: string[] = [];

afterEach(() => {
  while (STATE_DIRS.length > 0) {
    const dir = STATE_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

type AnyToolInput = V2ToolBeforeInput & V2ToolAfterInput;

interface FakeV2 {
  before: ((input: V2ToolBeforeInput) => Promise<unknown>) | null;
  after: ((input: V2ToolAfterInput) => Promise<unknown>) | null;
  interrupts: string[];
}

function fakeContext(fake: FakeV2): V2PluginContext {
  const registered = new Map<string, (input: AnyToolInput) => Promise<unknown>>();
  return {
    tool: {
      hook: async (name: string, callback: (input: AnyToolInput) => Promise<unknown>) => {
        registered.set(name, callback);
        if (name === "execute.before") {
          fake.before = (input) => callback(input);
        } else {
          fake.after = (input) => callback(input);
        }
      },
    },
    session: {
      interrupt: async (input: { sessionID: string }) => {
        fake.interrupts.push(input.sessionID);
      },
    },
  };
}

async function setup(
  overrides: Record<string, unknown> = {},
): Promise<{ fake: FakeV2; fetch: FetchStub }> {
  const stateDir = mkdtempSync(join(tmpdir(), "taa-plugin-v2-"));
  STATE_DIRS.push(stateDir);
  const fake: FakeV2 = { before: null, after: null, interrupts: [] };
  const fetch = fetchStub({
    "/api/me/session-policy": () => jsonResponse(policyPayload(overrides)),
    "/api/me/session-events": () => jsonResponse({ ok: true }, 202),
  });
  await setupV2Plugin(fakeContext(fake), {
    stateDir,
    baseUrl: "http://127.0.0.1:1",
    key: "test-member-key",
    fetchImpl: fetch.fetchImpl,
    env: {},
    logger: { warn: () => undefined },
    now: () => new Date("2026-11-01T12:00:00Z").getTime(),
  });
  return { fake, fetch };
}

function beforeInput(n: number): V2ToolBeforeInput {
  return {
    tool: "shell",
    sessionID: "ses_v2",
    id: `call_${n}`,
    input: { command: `echo STEP-${n}` },
  };
}

test("v2 entry pauses at 15 steps, interrupts on the next blocked call, then resumes", async () => {
  const { fake } = await setup();
  const before = fake.before;
  assert.ok(before !== null);
  for (let n = 1; n <= 15; n++) {
    await before(beforeInput(n));
  }
  // First pause block carries the rule text; the abort is deferred so the
  // model actually sees it.
  await assert.rejects(before(beforeInput(16)), /Unattended session paused: 15 steps without/);
  assert.deepEqual(fake.interrupts, []);
  // The runaway persists: the next blocked tool interrupts the session,
  // which clears the pause so the resumed session counts fresh steps.
  await assert.rejects(before(beforeInput(17)), /Unattended session paused: 15 steps without/);
  assert.deepEqual(fake.interrupts, ["ses_v2"]);
  await before(beforeInput(18));
  assert.deepEqual(fake.interrupts, ["ses_v2"]);
});

test("v2 entry blocks the same tool and arguments five times in a row", async () => {
  const { fake } = await setup();
  const before = fake.before;
  assert.ok(before !== null);
  const same = beforeInput(1);
  for (let n = 0; n < 4; n++) {
    await before({ ...same, id: `call_loop_${n}` });
  }
  await assert.rejects(before({ ...same, id: "call_loop_4" }), /Loop paused/);
  assert.deepEqual(fake.interrupts, []);
  await assert.rejects(before({ ...same, id: "call_loop_5" }), /Loop paused/);
  assert.deepEqual(fake.interrupts, ["ses_v2"]);
});

test("v2 entry stops at the session budget and interrupts once", async () => {
  const { fake } = await setup({
    budget: { limitUsd: 1, spentUsd: 1, warnRatios: [0.5, 0.8], stopRatio: 1 },
  });
  const before = fake.before;
  assert.ok(before !== null);
  await assert.rejects(before(beforeInput(1)), /Session budget exhausted/);
  assert.deepEqual(fake.interrupts, ["ses_v2"]);
});
