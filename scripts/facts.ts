/**
 * Facts and licence guard.
 *
 * Every number published in the README, the project page or
 * `project-facts.json` must come from a file committed under `results/`.
 * A fact names its source file and the JSON pointer inside it; this script
 * recomputes the value from that file and refuses a mismatch. `--write`
 * rewrites the values in `project-facts.json` from the sources, so a published
 * number is produced by this check instead of typed by hand.
 *
 * The README is then audited in both directions: every fact must appear in
 * it, and every number in it must be either a fact or a declared constant.
 * Constants are non-result numbers (a port, a version, a product default) and
 * each one carries the reason it is not a result. `project-facts.json` is the
 * single place to declare them.
 *
 * The licence check is unchanged: the project promises MIT and names its
 * author and year.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

type FactOp = "value" | "length" | "count" | "match";

interface FactWhere {
  field: string;
  equals: string | number | boolean;
}

interface Fact {
  id: string;
  value: string | number;
  source: string;
  pointer: string;
  op?: FactOp;
  /** First capture group, for `op: "match"`. */
  pattern?: string;
  /** Entry filter, for `op: "count"`. */
  where?: FactWhere;
  note?: string;
}

interface Constant {
  value: string;
  why: string;
}

interface FactsFile {
  version: number;
  facts: Fact[];
  constants: Constant[];
}

interface SourceDocument {
  path: string;
  json: unknown;
}

export class FactsError extends Error {
  override readonly name = "FactsError";
}

function fail(message: string): never {
  throw new FactsError(message);
}

/** A JSON pointer (`/a/0/b`) to the value inside a parsed document. */
function pointerValue(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) fail(`pointer must start with "/": ${pointer}`);
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        fail(`pointer ${pointer} leaves the array at "${key}"`);
      }
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      fail(`pointer ${pointer} cannot read "${key}"`);
    }
  }
  return current;
}

function derivedValue(fact: Fact, document: unknown): string | number {
  const target = pointerValue(document, fact.pointer);
  switch (fact.op ?? "value") {
    case "length": {
      if (Array.isArray(target) || typeof target === "string") return target.length;
      return fail(`fact ${fact.id}: length needs an array or string at ${fact.pointer}`);
    }
    case "count": {
      if (!Array.isArray(target)) {
        return fail(`fact ${fact.id}: count needs an array at ${fact.pointer}`);
      }
      const where = fact.where;
      if (where === undefined) return fail(`fact ${fact.id}: count needs a where filter`);
      return target.filter((entry) => {
        if (entry === null || typeof entry !== "object") return false;
        return (entry as Record<string, unknown>)[where.field] === where.equals;
      }).length;
    }
    case "match": {
      if (typeof target !== "string") return fail(`fact ${fact.id}: match needs a string`);
      if (fact.pattern === undefined) return fail(`fact ${fact.id}: match needs a pattern`);
      const match = new RegExp(fact.pattern).exec(target);
      const captured = match?.[1];
      if (captured === undefined) {
        return fail(`fact ${fact.id}: pattern did not match ${fact.source}`);
      }
      return /^-?\d+(?:\.\d+)?$/.test(captured) ? Number(captured) : captured;
    }
    default: {
      if (typeof target === "string" || typeof target === "number") return target;
      return fail(`fact ${fact.id}: ${fact.pointer} is not a string or number`);
    }
  }
}

/** Same number formatting on both sides, so 0.50 and 0.5 compare equal. */
function sameValue(expected: string | number, actual: string | number): boolean {
  return String(expected) === String(actual);
}

const NUMBER = /(?<![\w.])\d+(?:[.,]\d+)*(?![\w.])/g;

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((token) => token.replaceAll(",", ""));
}

function checkReadme(root: string, facts: readonly Fact[], constants: readonly Constant[]): void {
  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) fail("README.md is missing");
  const readme = readFileSync(readmePath, "utf8");

  for (const fact of facts) {
    const needle = String(fact.value).replaceAll(",", "");
    if (!readme.replaceAll(",", "").includes(needle)) {
      fail(`README.md does not publish fact ${fact.id} (${needle})`);
    }
  }

  const allowed = new Set<string>();
  for (const fact of facts) for (const token of numbersIn(String(fact.value))) allowed.add(token);
  for (const constant of constants) {
    for (const token of numbersIn(constant.value)) allowed.add(token);
  }

  for (const match of readme.matchAll(NUMBER)) {
    const raw = match[0];
    const token = raw.replaceAll(",", "");
    if (allowed.has(token)) continue;
    const at = match.index ?? 0;
    const context = readme.slice(
      Math.max(0, at - 40),
      Math.min(readme.length, at + raw.length + 40),
    );
    fail(
      `README.md has an undeclared number "${raw}" near "${context.replaceAll(/\s+/g, " ").trim()}". ` +
        "Publish it as a fact with a results/ source, or declare it as a constant with a reason.",
    );
  }
}

export interface FactsSummary {
  facts: number;
  constants: number;
}

/**
 * Validate the published numbers. Throws `FactsError` on the first failure.
 * With `write`, the fact values are recomputed and the file is rewritten
 * before the README and licence checks run.
 */
export function validate(root: string, options: { write?: boolean } = {}): FactsSummary {
  const factsPath = join(root, "project-facts.json");
  if (!existsSync(factsPath)) fail("project-facts.json is missing");

  let parsed: FactsFile;
  try {
    parsed = JSON.parse(readFileSync(factsPath, "utf8")) as FactsFile;
  } catch (error) {
    fail(`project-facts.json is not valid JSON: ${String(error)}`);
  }
  if (parsed.version !== 1) fail("project-facts.json must have version 1");
  if (!Array.isArray(parsed.facts)) fail("project-facts.json must have a facts array");
  if (!Array.isArray(parsed.constants)) fail("project-facts.json must have a constants array");

  const ids = new Set<string>();
  const sources = new Map<string, SourceDocument>();

  for (const fact of parsed.facts) {
    if (typeof fact.id !== "string" || fact.id.length === 0) fail("a fact has no id");
    if (ids.has(fact.id)) fail(`duplicate fact id ${fact.id}`);
    ids.add(fact.id);

    if (typeof fact.source !== "string" || fact.source.length === 0) {
      fail(`fact ${fact.id} has no source`);
    }
    const normalized = normalize(fact.source);
    if (isAbsolute(normalized) || normalized.startsWith("..")) {
      fail(`fact ${fact.id} source must be a relative path`);
    }
    if (!normalized.startsWith("results/")) {
      fail(`fact ${fact.id} source must live under results/`);
    }
    const sourcePath = join(root, normalized);
    if (!existsSync(sourcePath)) fail(`fact ${fact.id} source is missing: ${fact.source}`);

    let source = sources.get(normalized);
    if (source === undefined) {
      const text = readFileSync(sourcePath, "utf8");
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        fail(`fact ${fact.id} source must be JSON: ${fact.source}`);
      }
      source = { path: normalized, json };
      sources.set(normalized, source);
    }

    if (typeof fact.pointer !== "string") fail(`fact ${fact.id} has no pointer`);
    const actual = derivedValue(fact, source.json);
    if (options.write === true) {
      fact.value = actual;
    } else if (!sameValue(fact.value, actual)) {
      fail(
        `fact ${fact.id} is ${String(fact.value)} but ${fact.source}${fact.pointer} is ${String(actual)}`,
      );
    }
  }

  for (const constant of parsed.constants) {
    if (typeof constant.value !== "string" || constant.value.length === 0) {
      fail("a constant has no value");
    }
    if (typeof constant.why !== "string" || constant.why.length === 0) {
      fail(`constant ${constant.value} has no reason`);
    }
  }

  if (options.write === true) {
    writeFileSync(factsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  checkReadme(root, parsed.facts, parsed.constants);

  const licensePath = join(root, "LICENSE");
  if (!existsSync(licensePath)) fail("LICENSE is missing");
  const license = readFileSync(licensePath, "utf8");
  for (const needle of ["MIT License", "Saber Sojudi", "2026"]) {
    if (!license.includes(needle)) fail(`LICENSE does not contain "${needle}"`);
  }

  return { facts: parsed.facts.length, constants: parsed.constants.length };
}

/** The command-line entry point: prints the result and returns an exit code. */
export function run(root: string, options: { write?: boolean } = {}): number {
  try {
    const summary = validate(root, options);
    process.stdout.write(`facts: clean (${summary.facts} facts, ${summary.constants} constants)\n`);
    return 0;
  } catch (error) {
    if (error instanceof FactsError) {
      process.stderr.write(`facts: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = run(process.cwd(), { write: process.argv.includes("--write") });
}
