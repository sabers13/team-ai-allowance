/**
 * `node src/setup/cli.ts` — generate a setup bundle.
 *
 * The member key is read from `TAA_MEMBER_KEY` (or `TAA_MEMBER_KEY_FILE`,
 * mode 0600). It is never accepted as an argument, printed, or written
 * anywhere except the member env file in the output directory.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSetupBundle } from "./bundle.ts";
import { loadSetupSpec } from "./spec.ts";
import { SetupSpecError } from "./types.ts";
import { writeSetupBundle } from "./write.ts";

function usage(): string {
  return [
    "Usage: node src/setup/cli.ts --spec <file> --out <dir> [--force]",
    "",
    "Generates Claude Code, OpenCode and Codex managed configuration, a member",
    "environment file, macOS MDM templates and an install plan.",
    "",
    "The member gateway key is read from TAA_MEMBER_KEY or TAA_MEMBER_KEY_FILE",
    "(mode 0600), never from the command line.",
  ].join("\n");
}

interface Args {
  spec: string;
  out: string;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let spec: string | null = null;
  let out: string | null = null;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--spec" || arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new SetupSpecError(arg, "needs a value");
      index += 1;
      if (arg === "--spec") spec = value;
      else out = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new SetupSpecError("args", "help");
    } else {
      throw new SetupSpecError("args", `unknown argument: ${arg}`);
    }
  }
  if (spec === null) throw new SetupSpecError("--spec", "is required");
  if (out === null) throw new SetupSpecError("--out", "is required");
  return { spec, out, force };
}

async function memberKey(env: NodeJS.ProcessEnv): Promise<string> {
  const file = env.TAA_MEMBER_KEY_FILE;
  if (file !== undefined && file !== "") {
    const text = await readFile(file, "utf8");
    const key = text.replace(/[\r\n\s]+$/, "");
    if (key === "") throw new SetupSpecError("TAA_MEMBER_KEY_FILE", "file is empty");
    return key;
  }
  const key = env.TAA_MEMBER_KEY;
  if (key === undefined || key === "") {
    throw new SetupSpecError(
      "TAA_MEMBER_KEY",
      "is required (or set TAA_MEMBER_KEY_FILE to a mode-0600 file)",
    );
  }
  return key;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof SetupSpecError && error.message === "help") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  try {
    const spec = await loadSetupSpec(args.spec);
    const key = await memberKey(process.env);
    const bundle = generateSetupBundle(spec, key);
    await writeSetupBundle(bundle, args.out, { force: args.force });
    process.stdout.write(`setup bundle for ${spec.member.displayName} (${spec.team.name})\n`);
    for (const file of bundle.files) {
      const mode = file.mode.toString(8).padStart(4, "0");
      process.stdout.write(`  ${mode} ${join(args.out, file.path)}\n`);
    }
    process.stdout.write(
      `\nInstall the managed files as root with: sh deploy/managed/install.sh ${args.out}\n`,
    );
    process.stdout.write(
      `Install the member env yourself: install -m 0600 ${join(
        args.out,
        "member/taa.env",
      )} ~/.config/team-ai-allowance/env\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

process.exitCode = await main();
