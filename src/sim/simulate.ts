/**
 * Weekend simulation engine.
 *
 * A deterministic walk from Friday 17:30 to Monday 08:00 `Europe/Berlin`: one
 * model call every 45 s, context starting at 20,000 input tokens, growing by
 * 1,200 per step, compacting at 150,000 back to 40,000, and 600 output tokens
 * per step. Prices come from `config/prices.json`.
 *
 * The stops use the real rule functions, not copies of them:
 * - the budget hard limit from `hardLimitUsd` (`src/core/policy.ts`), with
 *   threshold markers from `reachedThresholds` (`src/watcher/caps.ts`);
 * - the off-hours window from `isWorkingTime` / `offHoursSegmentStart`
 *   (`src/watcher/offhours.ts`) with the default team policy;
 * - the unattended rule from the plugin's `isWorkingTime` and
 *   `DEFAULT_SESSION_POLICY` (`src/plugin/team-ai-allowance.ts`).
 *
 * Pure: no clock read, no network, no prompt or response text anywhere.
 */

import { DEFAULT_OFF_HOURS_CAP_USD, type OffHoursPolicy, type Thresholds } from "../contracts.ts";
import { defaultTeamPolicy, hardLimitUsd } from "../core/policy.ts";
import {
  DEFAULT_SESSION_POLICY,
  isWorkingTime as pluginIsWorkingTime,
} from "../plugin/team-ai-allowance.ts";
import { reachedThresholds } from "../watcher/caps.ts";
import { isWorkingTime, offHoursSegmentStart } from "../watcher/offhours.ts";

/** Wall-clock window of the simulated weekend, in Europe/Berlin. */
export const WEEKEND_START_BERLIN = "2026-10-30T17:30:00+01:00";
export const WEEKEND_END_BERLIN = "2026-11-02T08:00:00+01:00";

/** Friday 2026-10-30 to Monday 2026-11-02 is fully inside CET: no DST change. */
export const WEEKEND_START_MS = Date.parse(WEEKEND_START_BERLIN);
export const WEEKEND_END_MS = Date.parse(WEEKEND_END_BERLIN);

export const STEP_SECONDS = 45;
export const STEP_MS = STEP_SECONDS * 1000;
export const SAMPLE_EVERY_SECONDS = 15 * 60;

export const START_INPUT_TOKENS = 20_000;
export const GROWTH_PER_STEP = 1_200;
export const COMPACT_AT_TOKENS = 150_000;
export const COMPACT_TO_TOKENS = 40_000;
export const OUTPUT_TOKENS_PER_STEP = 600;

/** Fixed weekend allowance for the budget runs: no period reset inside. */
export const WEEKEND_BUDGET_USD = 20;

export type StopReason = "completed" | "budget_exhausted" | "off_hours_cap" | "unattended_pause";

export interface SimPrices {
  readonly modelId: string;
  readonly inputPer1MUsd: number;
  readonly outputPer1MUsd: number;
}

export interface SimScenario {
  /** File stem under `results/sim/`, e.g. `budget-only`. */
  readonly name: string;
  readonly title: string;
  readonly budgetUsd: number | null;
  readonly offHoursCapUsd: number | null;
  readonly unattended: boolean;
}

export const SCENARIOS: readonly SimScenario[] = [
  {
    name: "no-limits",
    title: "No limits",
    budgetUsd: null,
    offHoursCapUsd: null,
    unattended: false,
  },
  {
    name: "budget-only",
    title: "Member budget only",
    budgetUsd: WEEKEND_BUDGET_USD,
    offHoursCapUsd: null,
    unattended: false,
  },
  {
    name: "off-hours-only",
    title: "Off-hours cap only",
    budgetUsd: null,
    offHoursCapUsd: DEFAULT_OFF_HOURS_CAP_USD,
    unattended: false,
  },
  {
    name: "all-limits",
    title: "Member budget + off-hours cap + plugin unattended rule",
    budgetUsd: WEEKEND_BUDGET_USD,
    offHoursCapUsd: DEFAULT_OFF_HOURS_CAP_USD,
    unattended: true,
  },
];

export interface SimSample {
  readonly t: string;
  readonly step: number;
  readonly spendUsd: number;
  readonly offHoursSpendUsd: number;
  readonly inputTokens: number;
}

export interface SimMarker {
  readonly kind: "soft_limit" | "grace" | "hard_limit" | "off_hours_segment" | "stop";
  readonly t: string;
  readonly step: number;
}

export interface SimStop {
  readonly t: string;
  readonly step: number;
  readonly reason: StopReason;
  readonly spendUsd: number;
  readonly offHoursSpendUsd: number;
  readonly detail: string;
}

export interface SimResult {
  readonly label: "simulation";
  readonly scenario: string;
  readonly title: string;
  readonly assumptions: readonly string[];
  readonly parameters: {
    readonly weekendStart: string;
    readonly weekendEnd: string;
    readonly timeZone: string;
    readonly stepSeconds: number;
    readonly startInputTokens: number;
    readonly growthPerStepTokens: number;
    readonly compactAtTokens: number;
    readonly compactToTokens: number;
    readonly outputTokensPerStep: number;
    readonly sampleEverySeconds: number;
    readonly budgetUsd: number | null;
    readonly hardLimitUsd: number | null;
    readonly offHoursCapUsd: number | null;
    readonly unattended: boolean;
  };
  readonly prices: {
    readonly modelId: string;
    readonly inputPer1MUsd: number;
    readonly outputPer1MUsd: number;
  };
  readonly series: readonly SimSample[];
  readonly markers: readonly SimMarker[];
  readonly stop: SimStop;
  readonly totals: {
    readonly steps: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly spendUsd: number;
  };
}

const EPSILON = 1e-9;

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stepCostUsd(inputTokens: number, prices: SimPrices): number {
  return (
    (inputTokens * prices.inputPer1MUsd) / 1_000_000 +
    (OUTPUT_TOKENS_PER_STEP * prices.outputPer1MUsd) / 1_000_000
  );
}

/**
 * Run one scenario. Every decision goes through the real rule functions, so a
 * change to the policy, cap or plugin code changes the sim output.
 */
export function runSimulation(
  prices: SimPrices,
  scenario: SimScenario,
  offHours: OffHoursPolicy,
  thresholds: Thresholds,
): SimResult {
  const hardLimit =
    scenario.budgetUsd === null ? null : hardLimitUsd(scenario.budgetUsd, thresholds);
  const unattended = DEFAULT_SESSION_POLICY.unattended;

  const series: SimSample[] = [];
  const markers: SimMarker[] = [];
  const fired = new Set<string>();

  const fire = (kind: SimMarker["kind"], atMs: number, step: number): void => {
    const key = `${kind}:${step}`;
    if (fired.has(key)) return;
    fired.add(key);
    markers.push({ kind, t: iso(atMs), step });
  };

  let inputTokens = START_INPUT_TOKENS;
  let spend = 0;
  let offHoursSpend = 0;
  let segmentKey: string | null = null;
  let totalInput = 0;
  let executed = 0;

  // The last human message is Friday 17:30, the sim start.
  const lastHumanMs = WEEKEND_START_MS;
  let stepsSinceHuman = 0;

  let stop: SimStop | null = null;
  let nowMs = WEEKEND_START_MS;
  let step = 0;

  while (nowMs < WEEKEND_END_MS) {
    // 1. The gateway refuses before the call when the budget is exhausted.
    if (hardLimit !== null && spend + EPSILON >= hardLimit) {
      stop = {
        t: iso(nowMs),
        step,
        reason: "budget_exhausted",
        spendUsd: roundCents(spend),
        offHoursSpendUsd: roundCents(offHoursSpend),
        detail: `weekend allowance USD ${scenario.budgetUsd?.toFixed(2)} exhausted (hard limit USD ${hardLimit.toFixed(2)}); the gateway refuses the next call`,
      };
      break;
    }

    // 2. The watcher blocks the key once off-hours spend passes the cap.
    const now = new Date(nowMs);
    const working = isWorkingTime(now, offHours);
    if (scenario.offHoursCapUsd !== null && !working) {
      const segment = offHoursSegmentStart(now, offHours);
      const key = segment === null ? "none" : segment.toISOString();
      if (segmentKey !== key) {
        segmentKey = key;
        offHoursSpend = 0;
        fire("off_hours_segment", nowMs, step);
      }
      if (offHoursSpend + EPSILON >= scenario.offHoursCapUsd) {
        stop = {
          t: iso(nowMs),
          step,
          reason: "off_hours_cap",
          spendUsd: roundCents(spend),
          offHoursSpendUsd: roundCents(offHoursSpend),
          detail: `off-hours spend USD ${roundCents(offHoursSpend).toFixed(2)} reached the cap of USD ${scenario.offHoursCapUsd.toFixed(2)}; the key stays blocked until the next working-hours start`,
        };
        break;
      }
    }

    // 3. The plugin pauses an unattended session before the next tool call.
    if (scenario.unattended) {
      const offShift = !pluginIsWorkingTime(unattended.workingHours, nowMs);
      const limits = offShift ? unattended.offHours : unattended.working;
      const elapsedMs = nowMs - lastHumanMs;
      if (elapsedMs >= limits.maxMinutes * 60_000) {
        stop = {
          t: iso(nowMs),
          step,
          reason: "unattended_pause",
          spendUsd: roundCents(spend),
          offHoursSpendUsd: roundCents(offHoursSpend),
          detail: `${Math.floor(elapsedMs / 60_000)} minutes without a human message (${offShift ? "off-hours" : "working-hours"} limit ${limits.maxMinutes}); the plugin pauses the session`,
        };
        break;
      }
      if (stepsSinceHuman >= limits.maxSteps) {
        stop = {
          t: iso(nowMs),
          step,
          reason: "unattended_pause",
          spendUsd: roundCents(spend),
          offHoursSpendUsd: roundCents(offHoursSpend),
          detail: `${stepsSinceHuman} steps without a human message (${offShift ? "off-hours" : "working-hours"} limit ${limits.maxSteps}); the plugin pauses the session`,
        };
        break;
      }
    }

    // 4. The call runs: compact first when the context is full, then pay.
    if (inputTokens >= COMPACT_AT_TOKENS) inputTokens = COMPACT_TO_TOKENS;
    const usedInput = inputTokens;
    const cost = stepCostUsd(usedInput, prices);
    spend += cost;
    if (!working) offHoursSpend += cost;
    totalInput += usedInput;
    executed += 1;
    stepsSinceHuman += 1;

    // Threshold markers use the real cap math.
    if (scenario.budgetUsd !== null) {
      for (const kind of reachedThresholds(spend, scenario.budgetUsd, thresholds)) {
        fire(kind, nowMs, step);
      }
    }

    if ((nowMs - WEEKEND_START_MS) % (SAMPLE_EVERY_SECONDS * 1000) === 0) {
      series.push({
        t: iso(nowMs),
        step,
        spendUsd: roundCents(spend),
        offHoursSpendUsd: roundCents(offHoursSpend),
        inputTokens: usedInput,
      });
    }

    inputTokens = usedInput + GROWTH_PER_STEP;
    nowMs += STEP_MS;
    step += 1;
  }

  if (stop === null) {
    stop = {
      t: iso(WEEKEND_END_MS),
      step,
      reason: "completed",
      spendUsd: roundCents(spend),
      offHoursSpendUsd: roundCents(offHoursSpend),
      detail: "the agent loop reached Monday 08:00; nothing stopped it",
    };
  }
  fire("stop", Date.parse(stop.t), stop.step);

  return {
    label: "simulation",
    scenario: scenario.name,
    title: scenario.title,
    assumptions: [
      "Simulation, not a measurement: a fake clock, fixed token counts and example list prices. No real model was called.",
      `One model call every ${STEP_SECONDS} s from Friday 17:30 to Monday 08:00 Europe/Berlin (${WEEKEND_START_BERLIN} to ${WEEKEND_END_BERLIN}); no DST change inside the window.`,
      `Context starts at ${START_INPUT_TOKENS} input tokens, grows by ${GROWTH_PER_STEP} per step and compacts at ${COMPACT_AT_TOKENS} back to ${COMPACT_TO_TOKENS}; every step emits ${OUTPUT_TOKENS_PER_STEP} output tokens.`,
      "The member budget is a fixed weekend allowance; no period resets inside the window and no prior spend.",
      "Off-hours follow the default team policy (Mon-Fri 07:00-19:00 Europe/Berlin, no holidays).",
      "The unattended rule counts every model call as one step since the last human message (Friday 17:30), using the plugin's own working-hours test and default limits.",
    ],
    parameters: {
      weekendStart: WEEKEND_START_BERLIN,
      weekendEnd: WEEKEND_END_BERLIN,
      timeZone: offHours.timeZone,
      stepSeconds: STEP_SECONDS,
      startInputTokens: START_INPUT_TOKENS,
      growthPerStepTokens: GROWTH_PER_STEP,
      compactAtTokens: COMPACT_AT_TOKENS,
      compactToTokens: COMPACT_TO_TOKENS,
      outputTokensPerStep: OUTPUT_TOKENS_PER_STEP,
      sampleEverySeconds: SAMPLE_EVERY_SECONDS,
      budgetUsd: scenario.budgetUsd,
      hardLimitUsd: hardLimit,
      offHoursCapUsd: scenario.offHoursCapUsd,
      unattended: scenario.unattended,
    },
    prices: {
      modelId: prices.modelId,
      inputPer1MUsd: prices.inputPer1MUsd,
      outputPer1MUsd: prices.outputPer1MUsd,
    },
    series,
    markers,
    stop,
    totals: {
      steps: executed,
      inputTokens: totalInput,
      outputTokens: executed * OUTPUT_TOKENS_PER_STEP,
      spendUsd: roundCents(spend),
    },
  };
}

/** The default team policy the sim runs against (real policy function). */
export function simPolicy(): { offHours: OffHoursPolicy; thresholds: Thresholds } {
  const policy = defaultTeamPolicy("sim", new Date(WEEKEND_START_MS));
  return { offHours: policy.offHours, thresholds: policy.thresholds };
}

/** Run all four weekend scenarios in a fixed order. */
export function runAllScenarios(prices: SimPrices): SimResult[] {
  const { offHours, thresholds } = simPolicy();
  return SCENARIOS.map((scenario) => runSimulation(prices, scenario, offHours, thresholds));
}
