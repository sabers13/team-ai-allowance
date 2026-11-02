/**
 * Name guard.
 *
 * The repository must never contain an employer or a private person's name.
 * Only sha256 hashes of the forbidden tokens live in `config/forbidden.sha256`;
 * this script hashes every token it sees and compares, so it can report a hit
 * without ever printing the name.
 *
 * Token rules:
 *   - lowercase the text
 *   - token: [a-z0-9][a-z0-9._+-]*
 *   - strip leading and trailing [._+-]
 *   - hash the token, and each part split on [._+-]+, with sha256
 *
 * Scope: every tracked or untracked-but-not-ignored text file under 8 MB, plus
 * the last 50 commit messages.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const COMMIT_WINDOW = 50;
const SKIP_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".cache",
  "caches",
  "test-results",
  "playwright-report",
  "coverage",
  "dist",
]);
const TOKEN_RE = /[a-z0-9][a-z0-9._+-]*/g;
const EDGE_RE = /^[._+-]+|[._+-]+$/g;
const SPLIT_RE = /[._+-]+/;

export function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Return the stripped tokens of one line, in order, with duplicates preserved. */
export function tokenize(line: string): string[] {
  const lower = line.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(TOKEN_RE)) {
    const raw = match[0].replace(EDGE_RE, "");
    if (raw.length > 0) tokens.push(raw);
  }
  return tokens;
}

/** Every hash a token contributes: the token itself and each split part. */
export function candidateHashes(token: string): string[] {
  const parts = token.split(SPLIT_RE).filter((part) => part.length > 0);
  const values = new Set<string>([token, ...parts]);
  return [...values].map(hashHex);
}

export function loadForbidden(path: string): Set<string> {
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return new Set(lines);
}

export interface ScanHit {
  location: string;
  hashPrefix: string;
}

export function scanText(
  text: string,
  forbidden: ReadonlySet<string>,
  location: string,
): ScanHit[] {
  const hits: ScanHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const token of tokenize(line)) {
      for (const hash of candidateHashes(token)) {
        if (forbidden.has(hash)) {
          hits.push({ location: `${location}:${index + 1}`, hashPrefix: hash.slice(0, 12) });
          break;
        }
      }
    }
  }
  return hits;
}

function isTextFile(path: string): boolean {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;
    size = stat.size;
  } catch {
    return false;
  }
  if (size === 0) return true;
  const buffer = readFileSync(path);
  return !buffer.includes(0);
}

function skipped(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment));
}

function listCandidateFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => !skipped(path))
    .map((path) => join(root, path));
}

function scanCommits(root: string, forbidden: ReadonlySet<string>): ScanHit[] {
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["log", `-n${COMMIT_WINDOW}`, "--format=%H%x00%B%x00", "--no-color"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const hits: ScanHit[] = [];
  const records = log.split("\0");
  for (let index = 0; index + 1 < records.length; index += 2) {
    const sha = (records[index] ?? "").trim();
    if (sha.length === 0) continue;
    const body = records[index + 1] ?? "";
    hits.push(...scanText(body, forbidden, `commit:${sha.slice(0, 12)}`));
  }
  return hits;
}

export function run(root: string): number {
  const forbiddenPath = join(root, "config", "forbidden.sha256");
  let forbidden: Set<string>;
  try {
    forbidden = loadForbidden(forbiddenPath);
  } catch {
    process.stderr.write("scan-forbidden: config/forbidden.sha256 is missing\n");
    return 1;
  }
  if (forbidden.size === 0) {
    process.stderr.write("scan-forbidden: config/forbidden.sha256 is empty\n");
    return 1;
  }

  const hits: ScanHit[] = [];
  for (const path of listCandidateFiles(root)) {
    if (!isTextFile(path)) continue;
    const text = readFileSync(path, "utf8");
    hits.push(...scanText(text, forbidden, relative(root, path)));
  }
  hits.push(...scanCommits(root, forbidden));

  if (hits.length === 0) {
    process.stdout.write(`scan-forbidden: clean (${forbidden.size} hashes)\n`);
    return 0;
  }

  for (const hit of hits) {
    process.stdout.write(`scan-forbidden: ${hit.location} hash ${hit.hashPrefix}\n`);
  }
  process.stderr.write(`scan-forbidden: ${hits.length} hit(s); remove the name\n`);
  return 1;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = run(process.cwd());
}
