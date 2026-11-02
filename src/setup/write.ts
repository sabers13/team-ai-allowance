/**
 * Write a generated bundle to a directory.
 *
 * The writer refuses a path that escapes the output directory and refuses to
 * overwrite an existing file unless asked. Generation itself stays in memory
 * so tests can inspect every byte.
 */

import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { SetupBundle } from "./types.ts";

export class BundleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleWriteError";
  }
}

export interface WriteOptions {
  force?: boolean;
}

export async function writeSetupBundle(
  bundle: SetupBundle,
  outDir: string,
  options: WriteOptions = {},
): Promise<string[]> {
  const root = resolve(outDir);
  await mkdir(root, { recursive: true });
  const written: string[] = [];

  for (const file of bundle.files) {
    const path = resolve(root, file.path);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new BundleWriteError(`refusing path outside the bundle: ${file.path}`);
    }
    if (options.force !== true) {
      try {
        await stat(path);
        throw new BundleWriteError(`refusing to overwrite ${file.path}; pass --force`);
      } catch (error) {
        if (error instanceof BundleWriteError) throw error;
      }
    }
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, file.contents, { mode: file.mode });
    await chmod(path, file.mode);
    written.push(path);
  }

  return written;
}
