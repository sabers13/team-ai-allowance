import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BundleWriteError,
  generateSetupBundle,
  SetupSpecError,
  writeSetupBundle,
} from "../../src/setup/index.ts";
import { KEY, spec } from "./fixture.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "taa-setup-"));
}

test("the writer lays out the bundle with the declared modes", async () => {
  const out = temp();
  const bundle = generateSetupBundle(spec(), KEY);
  const written = await writeSetupBundle(bundle, out);
  assert.equal(written.length, bundle.files.length);

  const env = join(out, "member/taa.env");
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.match(readFileSync(env, "utf8"), new RegExp(`TAA_MEMBER_KEY=${KEY}`));

  const managed = join(out, "managed/claude-code/managed-settings.json");
  assert.equal(statSync(managed).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(managed, "utf8")), {
    env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
    model: "model-a",
    availableModels: ["model-a", "model-b"],
    allowedProviders: ["customEndpoint"],
  });
});

test("the writer refuses to overwrite without --force", async () => {
  const out = temp();
  const bundle = generateSetupBundle(spec(), KEY);
  await writeSetupBundle(bundle, out);
  await assert.rejects(() => writeSetupBundle(bundle, out), BundleWriteError);
  await writeSetupBundle(bundle, out, { force: true });
});

test("the writer refuses a path outside the output directory", async () => {
  const out = temp();
  const bundle = generateSetupBundle(spec(), KEY);
  bundle.files.push({ path: "../escape.txt", contents: "x", mode: 0o644 });
  await assert.rejects(() => writeSetupBundle(bundle, out), /outside the bundle/);
  await assert.rejects(
    () =>
      writeSetupBundle(
        { ...bundle, files: [{ path: "/tmp/abs.txt", contents: "x", mode: 0o644 }] },
        out,
      ),
    /outside the bundle/,
  );
});

test("an unsafe key is rejected before anything is written", () => {
  assert.throws(() => generateSetupBundle(spec(), "bad key\nsecond=1"), SetupSpecError);
});

test("install.txt is a plain plan the shell script can read", () => {
  const bundle = generateSetupBundle(spec(), KEY);
  const install = bundle.files.find((file) => file.path === "install.txt")?.contents ?? "";
  const lines = install.trim().split("\n");
  assert.equal(lines.length, 5);
  for (const line of lines) {
    const fields = line.split(" ");
    assert.equal(fields.length, 4);
    assert.equal(fields[0], "0644");
    assert.equal(fields[1], "root:root");
    assert.match(fields[2] ?? "", /^managed\//);
    assert.match(fields[3] ?? "", /^\/etc\//);
  }
});

test("the install plan never carries the key", () => {
  const bundle = generateSetupBundle(spec(), KEY);
  const install = bundle.files.find((file) => file.path === "install.txt")?.contents ?? "";
  assert.equal(install.includes(KEY), false);
});
