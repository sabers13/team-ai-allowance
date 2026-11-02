/**
 * Model-hint file: which cheaper model to try before asking for an
 * approval-required one. The shipped example lives
 * at `config/model-hints.json`.
 *
 * ```json
 * { "version": 1, "hints": [{ "modelId": "flagship", "instead": ["flash"], "note": "why" }] }
 * ```
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelHint {
  readonly modelId: string;
  readonly instead: readonly string[];
  readonly note: string | null;
}

export interface HintsFile {
  readonly hints: readonly ModelHint[];
}

const DEFAULT_PATH = join(homedir(), ".config", "team-ai-allowance", "model-hints.json");

/** Where `taa hints import` stores the file, unless `TAA_HINTS_FILE` says otherwise. */
export function defaultHintsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TAA_HINTS_FILE;
  return override !== undefined && override.trim() !== "" ? override.trim() : DEFAULT_PATH;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse and validate a hints document; throws a readable error on bad shape. */
export function parseHintsFile(text: string): HintsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("hints file is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('hints file must be an object with a "hints" array');
  }
  const raw = (parsed as { hints?: unknown }).hints;
  if (!Array.isArray(raw)) throw new Error('hints file must be an object with a "hints" array');
  const hints: ModelHint[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`hints[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const modelId = asString(record.modelId);
    const insteadRaw = record.instead;
    const noteRaw = record.note;
    if (modelId === null || modelId === "")
      throw new Error(`hints[${index}].modelId must be a string`);
    if (!Array.isArray(insteadRaw) || insteadRaw.some((id) => typeof id !== "string")) {
      throw new Error(`hints[${index}].instead must be an array of model ids`);
    }
    if (noteRaw !== undefined && typeof noteRaw !== "string") {
      throw new Error(`hints[${index}].note must be a string`);
    }
    hints.push({
      modelId,
      instead: insteadRaw as string[],
      note: typeof noteRaw === "string" ? noteRaw : null,
    });
  }
  return { hints };
}

/** Load the stored hints, or an empty set when none were imported yet. */
export async function loadHints(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HintsFile> {
  const file = path ?? defaultHintsPath(env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { hints: [] };
  }
  return parseHintsFile(text);
}

/** The cheaper alternative for a model, or null when no hint exists. */
export function findHint(hints: HintsFile, modelId: string): ModelHint | null {
  return hints.hints.find((hint) => hint.modelId === modelId) ?? null;
}
