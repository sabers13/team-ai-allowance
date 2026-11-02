/**
 * Weekend simulation tests.
 *
 * The sim must be deterministic (byte-identical), use the real rule functions,
 * and stop each scenario for the right reason at the right time.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hardLimitUsd } from "../../src/core/policy.ts";
import { DEFAULT_SESSION_POLICY } from "../../src/plugin/team-ai-allowance.ts";
import {
  loadPrices,
  parsePrices,
  runAllScenarios,
  runAllToDir,
  SIM_MODEL_ID,
  type SimResult,
  serializeResult,
  simPrices,
} from "../../src/sim/index.ts";
import {
  COMPACT_AT_TOKENS,
  OUTPUT_TOKENS_PER_STEP,
  SAMPLE_EVERY_SECONDS,
  SCENARIOS,
  STEP_SECONDS,
  simPolicy,
  WEEKEND_BUDGET_USD,
  WEEKEND_END_MS,
  WEEKEND_START_MS,
} from "../../src/sim/simulate.ts";
import { isWorkingTime } from "../../src/watcher/offhours.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PRICES_PATH = join(ROOT, "config", "prices.json");

function prices() {
  return simPrices(loadPrices(PRICES_PATH), SIM_MODEL_ID);
}

function byName(results: SimResult[], name: string): SimResult {
  const found = results.find((result) => result.scenario === name);
  assert.ok(found !== undefined, `scenario ${name} ran`);
  return found;
}

test("prices.json holds two example list prices with source and date", () => {
  const table = loadPrices(PRICES_PATH);
  assert.equal(table.version, 1);
  assert.ok(table.models.length >= 2);
  for (const model of table.models) {
    assert.ok(model.inputPer1MUsd > 0);
    assert.ok(model.outputPer1MUsd > 0);
    assert.match(model.source, /^https:\/\//);
    assert.match(model.sourceRetrieved, /^\d{4}-\d{2}-\d{2}$/);
  }
  const flash = simPrices(table);
  assert.equal(flash.modelId, SIM_MODEL_ID);
});

test("price parsing refuses to guess", () => {
  assert.throws(() => parsePrices("{"), /not valid JSON/);
  assert.throws(() => parsePrices('{"version":1}'), /unit must be set/);
  assert.throws(() => simPrices(loadPrices(PRICES_PATH), "no-such-model"), /not listed/);
});

test("the weekend is 5000 steps with no DST change inside", () => {
  assert.equal((WEEKEND_END_MS - WEEKEND_START_MS) / 1000 / STEP_SECONDS, 5000);
});

test("all four runs are byte-identical across runs", () => {
  const first = runAllScenarios(prices()).map(serializeResult);
  const second = runAllScenarios(prices()).map(serializeResult);
  assert.equal(first.length, 4);
  assert.deepEqual(first, second);
  for (const json of first) {
    assert.ok(json.endsWith("\n"));
    assert.ok(!json.includes('"prompt"'));
    assert.ok(!json.includes('"response"'));
    const parsed = JSON.parse(json) as { label: string };
    assert.equal(parsed.label, "simulation");
  }
});

test("no-limits runs the whole weekend", () => {
  const result = byName(runAllScenarios(prices()), "no-limits");
  assert.equal(result.stop.reason, "completed");
  assert.equal(result.stop.step, 5000);
  assert.equal(result.stop.t, new Date(WEEKEND_END_MS).toISOString());
  assert.equal(result.totals.steps, 5000);
  assert.equal(result.totals.outputTokens, 5000 * OUTPUT_TOKENS_PER_STEP);
  assert.equal(result.totals.inputTokens > 0, true);
  assert.deepEqual(
    result.series.map((sample) => sample.step),
    result.series.map((_, index) => index * 20),
  );
});

test("budget-only stops at the real hard limit", () => {
  const { thresholds } = simPolicy();
  const hard = hardLimitUsd(WEEKEND_BUDGET_USD, thresholds);
  assert.equal(hard, 21);
  const result = byName(runAllScenarios(prices()), "budget-only");
  assert.equal(result.stop.reason, "budget_exhausted");
  assert.ok(result.stop.step > 0 && result.stop.step < 5000);
  assert.ok(result.stop.spendUsd >= hard);
  const kinds = result.markers.map((marker) => marker.kind);
  const soft = kinds.indexOf("soft_limit");
  const grace = kinds.indexOf("grace");
  const hardMark = kinds.indexOf("hard_limit");
  assert.ok(soft !== -1 && grace !== -1 && hardMark !== -1);
  assert.ok(soft < grace && grace < hardMark);
});

test("off-hours-only stops off-hours at the cap", () => {
  const { offHours } = simPolicy();
  const result = byName(runAllScenarios(prices()), "off-hours-only");
  assert.equal(result.stop.reason, "off_hours_cap");
  assert.ok(result.stop.step > 120 && result.stop.step < 5000);
  assert.equal(isWorkingTime(new Date(result.stop.t), offHours), false);
  const last = result.series[result.series.length - 1];
  assert.ok(last !== undefined);
  assert.ok(last.offHoursSpendUsd > 0);
  assert.ok(result.stop.offHoursSpendUsd >= 5);
  assert.ok(result.markers.some((marker) => marker.kind === "off_hours_segment"));
});

test("all-limits stops first on the plugin unattended rule", () => {
  const results = runAllScenarios(prices());
  const full = byName(results, "all-limits");
  assert.equal(full.stop.reason, "unattended_pause");
  // Friday evening is working hours under the ISO weekday the product uses
  // everywhere (Monday = 1 ... Sunday = 7; see `src/watcher/offhours.ts`),
  // so the 30-minute / 40-step working-hours limit applies: the time and
  // step rules coincide at step 40 (18:00 Europe/Berlin).
  assert.equal(full.stop.step, 40);
  assert.equal(full.stop.t, new Date(WEEKEND_START_MS + 40 * STEP_SECONDS * 1000).toISOString());
  assert.match(full.stop.detail, /30 minutes without a human message \(working-hours limit 30\)/);
  const budget = byName(results, "budget-only");
  const offHours = byName(results, "off-hours-only");
  assert.ok(full.stop.step < offHours.stop.step);
  assert.ok(offHours.stop.step < budget.stop.step);
});

test("the series samples every 15 minutes on the grid", () => {
  for (const result of runAllScenarios(prices())) {
    assert.ok(result.series.length > 0);
    let previous = -1;
    for (const sample of result.series) {
      const elapsed = Date.parse(sample.t) - WEEKEND_START_MS;
      assert.equal(elapsed % (SAMPLE_EVERY_SECONDS * 1000), 0);
      assert.ok(elapsed > previous);
      previous = elapsed;
      assert.ok(sample.inputTokens >= 20_000 && sample.inputTokens < COMPACT_AT_TOKENS);
      assert.ok(sample.spendUsd >= 0);
    }
    const first = result.series[0];
    assert.ok(first !== undefined);
    assert.equal(first.t, new Date(WEEKEND_START_MS).toISOString());
  }
});

test("the unattended limits are the plugin's own defaults", () => {
  assert.equal(DEFAULT_SESSION_POLICY.unattended.working.maxMinutes, 30);
  assert.equal(DEFAULT_SESSION_POLICY.unattended.working.maxSteps, 40);
  assert.equal(DEFAULT_SESSION_POLICY.unattended.offHours.maxMinutes, 10);
  assert.equal(DEFAULT_SESSION_POLICY.unattended.offHours.maxSteps, 15);
});

test("writing the results round-trips byte-identically", () => {
  const dir = mkdtempSync(join(tmpdir(), "taa-sim-"));
  const table = loadPrices(PRICES_PATH);
  const written = runAllToDir(table, dir);
  assert.deepEqual(
    written,
    SCENARIOS.map((scenario) => join(dir, `${scenario.name}.json`)),
  );
  const again = mkdtempSync(join(tmpdir(), "taa-sim-"));
  runAllToDir(table, again);
  for (const scenario of SCENARIOS) {
    const left = readFileSync(join(dir, `${scenario.name}.json`), "utf8");
    const right = readFileSync(join(again, `${scenario.name}.json`), "utf8");
    assert.equal(left, right);
  }
});
