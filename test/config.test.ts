import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

test("config/forbidden.sha256 has exactly the seven hashes from the brief", () => {
  const path = join(ROOT, "config", "forbidden.sha256");
  assert.ok(existsSync(path), "config/forbidden.sha256 is missing");
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 7);
  for (const line of lines) {
    assert.match(line, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(lines).size, 7);
});

test("the public repository files exist", () => {
  for (const path of [
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "THIRD_PARTY.md",
    "docs/ADMIN.md",
    "docs/LOCKDOWN.md",
    "docs/MEMBER.md",
    "src/contracts.ts",
    "project-facts.json",
    "LICENSE",
  ]) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  }
});

test("package.json pins Node 24 and ESM", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    type?: string;
    engines?: { node?: string };
  };
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines?.node, ">=24");
});
