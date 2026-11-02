import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSessionPolicy, server } from "../../dist/plugin/team-ai-allowance.ts";
import { BANNER, OUTPUT_PATH, SOURCE_PATH } from "../../src/plugin/build.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("the committed build is current and self-contained", async () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const built = readFileSync(OUTPUT_PATH, "utf8");
  assert.equal(built, `${BANNER}\n${source}`, "run `node src/plugin/build.ts`");

  for (const match of built.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)) {
    assert.match(match[1] ?? "", /^node:/, "only Node built-ins may be imported at runtime");
  }
  assert.equal(/^\s*(?:const|let|var)\s+[^=]*=\s*require\(/m.test(built), false);
  assert.equal(/(?:^|[^\w.])eval\s*\(/m.test(built), false);
  assert.equal(typeof server, "function");
  const hooks = await server({ client: {} as never }, { env: {} });
  assert.equal(typeof hooks.event, "function");

  const example = JSON.parse(
    readFileSync(join(ROOT, "dist", "plugin", "session-policy.example.json"), "utf8"),
  ) as unknown;
  const policy = parseSessionPolicy(example);
  assert.equal(policy.budget.limitUsd, 2);
  assert.equal(policy.unattended.offHours.maxSteps, 15);
  assert.equal(policy.softLimitRatio, 0.8);
});

test("the built file type-checks under the project's strict settings", () => {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--target",
      "ES2024",
      "--lib",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--noUnusedLocals",
      "--noUnusedParameters",
      "--verbatimModuleSyntax",
      "--erasableSyntaxOnly",
      "--isolatedModules",
      "--forceConsistentCasingInFileNames",
      "--skipLibCheck",
      OUTPUT_PATH,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
