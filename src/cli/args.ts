/**
 * Tiny argv parser for `taa`. No dependency: flags are `--name value`,
 * `--name=value` or bare `--name` (true). The first non-flag token is the
 * command; the rest are its positionals.
 */

export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token.startsWith("--")) {
      const bare = token.slice(2);
      const equals = bare.indexOf("=");
      if (equals !== -1) {
        flags.set(bare.slice(0, equals), bare.slice(equals + 1));
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(bare, next);
        index += 2;
        continue;
      }
      flags.set(bare, true);
      index += 1;
      continue;
    }
    positionals.push(token);
    index += 1;
  }
  return { positionals, flags };
}

/** A required string flag, or a usage error naming the command. */
export function requiredFlag(args: ParsedArgs, name: string, command: string): string {
  const value = args.flags.get(name);
  if (typeof value === "string" && value !== "") return value;
  throw new UsageError(`taa ${command}: missing --${name}`);
}

/** An optional string flag. */
export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** True when `--name` was passed in any form. */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** A usage problem: exit 2 with the message on stderr. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
