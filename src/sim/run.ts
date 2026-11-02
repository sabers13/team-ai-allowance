#!/usr/bin/env node
/**
 * `make sim` entry point.
 *
 * Reads `config/prices.json` next to the repo root and writes the four
 * `results/sim/*.json` files. Run from anywhere: the root is derived from
 * this file's location, never from the working directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrices, runAllToDir } from "./index.ts";

const ROOT = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));

function main(): void {
  const table = loadPrices(join(ROOT, "config", "prices.json"));
  const outDir = join(ROOT, "results", "sim");
  const written = runAllToDir(table, outDir);
  for (const path of written) process.stdout.write(`sim: wrote ${path}\n`);
}

main();
