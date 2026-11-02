/**
 * Secret guard.
 *
 * Scans tracked and untracked-but-not-ignored text files for credential-shaped
 * strings. It prints the file, line and pattern name, never the match.
 *
 * This is a safety net, not a proof. A secret that never matches a pattern can
 * still be committed; manual review still applies before every commit.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SKIP_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".cache",
  "caches",
  "test-results",
  "playwright-report",
  "coverage",
]);

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: "secret-assignment",
    pattern:
      /\b(?:secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s${}]{16,}["']/i,
  },
];

export interface SecretHit {
  location: string;
  rule: string;
}

export function scanText(text: string, location: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({ location: `${location}:${index + 1}`, rule: rule.name });
      }
    }
  }
  return hits;
}

function skipped(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment));
}

function isTextFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;
    if (stat.size === 0) return true;
    return !readFileSync(path).includes(0);
  } catch {
    return false;
  }
}

export function run(root: string): number {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const files = output
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => !skipped(path));

  const hits: SecretHit[] = [];
  for (const path of files) {
    if (/^\.env(\.|$)/.test(path)) {
      hits.push({ location: path, rule: "dotenv-file" });
      continue;
    }
    const absolute = join(root, path);
    if (!isTextFile(absolute)) continue;
    hits.push(...scanText(readFileSync(absolute, "utf8"), relative(root, absolute)));
  }

  if (hits.length === 0) {
    process.stdout.write(`scan-secrets: clean (${files.length} files)\n`);
    return 0;
  }
  for (const hit of hits) {
    process.stdout.write(`scan-secrets: ${hit.location} ${hit.rule}\n`);
  }
  process.stderr.write(`scan-secrets: ${hits.length} hit(s); remove the value\n`);
  return 1;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = run(process.cwd());
}
