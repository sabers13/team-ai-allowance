/**
 * The facts guard is a published-number gate, so its own failure modes are
 * tested: a value that drifts from `results/`, a README number nobody declared,
 * a source outside `results/`, and the `--write` path that recomputes values.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validate } from "../scripts/facts.ts";

interface FixtureOptions {
  value?: number;
  source?: string;
  readme?: string;
}

function fixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "taa-facts-"));
  mkdirSync(join(root, "results"), { recursive: true });
  writeFileSync(join(root, "results", "data.json"), `${JSON.stringify({ count: 3 })}\n`);
  writeFileSync(
    join(root, "project-facts.json"),
    `${JSON.stringify(
      {
        version: 1,
        facts: [
          {
            id: "demo.count",
            value: options.value ?? 3,
            source: options.source ?? "results/data.json",
            pointer: "/count",
          },
        ],
        constants: [{ value: "1.0.0", why: "release version, not a result" }],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "README.md"),
    options.readme ?? "There are 3 things at version 1.0.0.\n",
  );
  writeFileSync(
    join(root, "LICENSE"),
    "MIT License\n\nCopyright (c) 2026 Saber Sojudi\n\nPermission is hereby granted...\n",
  );
  return root;
}

test("a matching fact and README pass", () => {
  assert.deepEqual(validate(fixture()), { facts: 1, constants: 1 });
});

test("a value that drifted from results fails", () => {
  assert.throws(
    () => validate(fixture({ value: 4 })),
    /fact demo\.count is 4 but results\/data\.json\/count is 3/,
  );
});

test("a README number without a fact or constant fails", () => {
  assert.throws(
    () => validate(fixture({ readme: "There are 3 things, and 42 others.\n" })),
    /undeclared number "42"/,
  );
});

test("a source outside results fails", () => {
  assert.throws(
    () => validate(fixture({ source: "other/data.json" })),
    /source must live under results\//,
  );
});

test("--write recomputes the value from the source before checking", () => {
  const root = fixture({ value: 4 });
  assert.deepEqual(validate(root, { write: true }), { facts: 1, constants: 1 });
  const written = JSON.parse(readFileSync(join(root, "project-facts.json"), "utf8")) as {
    facts: Array<{ value: number }>;
  };
  assert.equal(written.facts[0]?.value, 3);
});
