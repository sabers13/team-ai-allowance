/**
 * Weekend simulation public entry.
 *
 * `loadPrices` reads `config/prices.json`, `runAllToDir` runs the four weekend
 * scenarios and writes `results/sim/*.json`. Serialization is plain
 * `JSON.stringify` over insertion-ordered objects with a trailing newline, so
 * `make sim` is byte-identical run after run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAllScenarios, SCENARIOS, type SimPrices, type SimResult } from "./simulate.ts";

export type {
  SimMarker,
  SimResult,
  SimSample,
  SimScenario,
  SimStop,
  StopReason,
} from "./simulate.ts";
export { runAllScenarios, runSimulation, SCENARIOS } from "./simulate.ts";

export interface PriceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly inputPer1MUsd: number;
  readonly outputPer1MUsd: number;
  readonly source: string;
  readonly sourceRetrieved: string;
  readonly note: string;
}

export interface PriceTable {
  readonly version: 1;
  readonly unit: string;
  readonly retrieved: string;
  readonly models: readonly PriceEntry[];
}

/** The sim agent calls the cheap catalogue model. */
export const SIM_MODEL_ID = "flash";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`prices: ${message}`);
}

/** Parse and validate `config/prices.json`; the sim refuses to guess prices. */
export function parsePrices(text: string): PriceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("not valid JSON");
  }
  if (!isRecord(parsed)) fail("must be an object");
  if (parsed["version"] !== 1) fail("version must be 1");
  if (typeof parsed["unit"] !== "string" || parsed["unit"] === "") fail("unit must be set");
  if (typeof parsed["retrieved"] !== "string" || parsed["retrieved"] === "") {
    fail("retrieved date must be set");
  }
  if (!Array.isArray(parsed["models"]) || parsed["models"].length < 2) {
    fail("models must list at least two example prices");
  }
  const models: PriceEntry[] = [];
  for (const raw of parsed["models"] as unknown[]) {
    if (!isRecord(raw)) fail("every model must be an object");
    for (const field of ["id", "displayName", "source", "sourceRetrieved", "note"]) {
      if (typeof raw[field] !== "string" || (raw[field] as string) === "")
        fail(`model ${field} must be set`);
    }
    for (const field of ["inputPer1MUsd", "outputPer1MUsd"]) {
      const value = raw[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        fail(`model ${field} must be a positive number`);
      }
    }
    models.push({
      id: raw["id"] as string,
      displayName: raw["displayName"] as string,
      inputPer1MUsd: raw["inputPer1MUsd"] as number,
      outputPer1MUsd: raw["outputPer1MUsd"] as number,
      source: raw["source"] as string,
      sourceRetrieved: raw["sourceRetrieved"] as string,
      note: raw["note"] as string,
    });
  }
  return {
    version: 1,
    unit: parsed["unit"] as string,
    retrieved: parsed["retrieved"] as string,
    models,
  };
}

export function loadPrices(path: string): PriceTable {
  return parsePrices(readFileSync(path, "utf8"));
}

export function simPrices(table: PriceTable, modelId: string = SIM_MODEL_ID): SimPrices {
  const entry = table.models.find((model) => model.id === modelId);
  if (entry === undefined) fail(`model ${modelId} is not listed`);
  return {
    modelId: entry.id,
    inputPer1MUsd: entry.inputPer1MUsd,
    outputPer1MUsd: entry.outputPer1MUsd,
  };
}

/** Stable serialization: fixed key order, 2-space indent, trailing newline. */
export function serializeResult(result: SimResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * Run every scenario and write one JSON file per scenario. Returns the
 * written paths in scenario order.
 */
export function runAllToDir(
  table: PriceTable,
  outDir: string,
  modelId: string = SIM_MODEL_ID,
): string[] {
  const prices = simPrices(table, modelId);
  const results = runAllScenarios(prices);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const scenario = SCENARIOS[index];
    const result = results[index];
    if (scenario === undefined || result === undefined) continue;
    const path = join(outDir, `${scenario.name}.json`);
    writeFileSync(path, serializeResult(result), "utf8");
    written.push(path);
  }
  return written;
}
