/**
 * Manager CLI commands for scripts: `decide`, `block`, `unblock`, `audit`.
 * All need `TAA_MANAGER_TOKEN` (or its `*_FILE` form); a member key is
 * refused by the service, which surfaces as exit 1 with the reason.
 */

import { writeFile } from "node:fs/promises";
import type { DecisionOutcome } from "../contracts.ts";
import { ApiClient, formatUsd, loadManagerConfig } from "../mcp/index.ts";
import { hasFlag, optionalFlag, parseArgs, requiredFlag, UsageError } from "./args.ts";
import { printResult } from "./output.ts";

async function managerApi(env: NodeJS.ProcessEnv): Promise<ApiClient> {
  const config = await loadManagerConfig(env);
  return new ApiClient({ baseUrl: config.baseUrl, auth: config.token });
}

const outcomes: Readonly<Record<string, DecisionOutcome>> = {
  approve: "approved",
  partly: "partly_approved",
  deny: "denied",
};

/**
 * `taa decide <id> approve|partly|deny [--usd N] [--until DATE]
 * [--model M] [--permanent] --note "..."`.
 * A denial needs a note; the member reads it.
 */
export async function commandDecide(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args = parseArgs(argv);
  const [requestId, outcomeName] = args.positionals;
  if (requestId === undefined || requestId === "")
    throw new UsageError("taa decide <id> approve|partly|deny ...");
  const outcome = outcomeName === undefined ? undefined : outcomes[outcomeName];
  if (outcome === undefined)
    throw new UsageError(`taa decide: want approve|partly|deny, got "${outcomeName ?? ""}"`);
  const note = optionalFlag(args, "note");
  if (outcome === "denied" && (note === undefined || note === "")) {
    throw new UsageError("taa decide deny: a --note is required so the member knows why");
  }
  const usdRaw = optionalFlag(args, "usd");
  const amountUsd = usdRaw === undefined ? undefined : Number(usdRaw);
  if (
    usdRaw !== undefined &&
    (amountUsd === undefined || !Number.isFinite(amountUsd) || amountUsd <= 0)
  ) {
    throw new UsageError("taa decide: --usd must be > 0");
  }
  const untilRaw = optionalFlag(args, "until");
  let until: string | undefined;
  if (untilRaw !== undefined) {
    const time = Date.parse(untilRaw);
    if (Number.isNaN(time)) throw new UsageError(`taa decide: --until "${untilRaw}" is not a date`);
    until = new Date(time).toISOString();
  }
  const api = await managerApi(env);
  const result = await api.decideRequest(requestId, {
    outcome,
    note,
    amountUsd,
    modelId: optionalFlag(args, "model"),
    until,
    permanent: hasFlag(args, "permanent") ? true : undefined,
  });
  const head =
    outcome === "denied"
      ? "Denied"
      : outcome === "partly_approved"
        ? "Partly approved"
        : "Approved";
  const amount = amountUsd === undefined ? "" : ` ${formatUsd(amountUsd)}`;
  printResult(`${head}${amount}.`, result, hasFlag(args, "json"));
}

/** `taa block <member> --note "..."` / `taa unblock <member>`. */
export async function commandBlock(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  block: boolean,
): Promise<void> {
  const args = parseArgs(argv);
  const [memberId] = args.positionals;
  if (memberId === undefined || memberId === "") {
    throw new UsageError(block ? "taa block <member> --note ..." : "taa unblock <member>");
  }
  const api = await managerApi(env);
  if (block) {
    const note = requiredFlag(args, "note", "block");
    const result = await api.blockMember(memberId, note);
    printResult(`${result.member.displayName} is now blocked.`, result, hasFlag(args, "json"));
    return;
  }
  const result = await api.unblockMember(memberId);
  printResult(`${result.member.displayName} is now unblocked.`, result, hasFlag(args, "json"));
}

/**
 * `taa audit [--export <file>] [--limit N] [--actor ...] [--json]`.
 * Prints one line per event, or writes the full JSON to `--export`.
 */
export async function commandAudit(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseArgs(argv);
  if (args.positionals.length > 0) throw new UsageError("taa audit takes no arguments");
  const limitRaw = optionalFlag(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && (limit === undefined || !Number.isInteger(limit) || limit <= 0)) {
    throw new UsageError("taa audit: --limit must be a positive integer");
  }
  const api = await managerApi(env);
  const events = await api.audit({
    actorId: optionalFlag(args, "actor"),
    objectType: optionalFlag(args, "object"),
    from: optionalFlag(args, "from"),
    to: optionalFlag(args, "to"),
    limit,
  });
  const exportFile = optionalFlag(args, "export");
  if (exportFile !== undefined) {
    await writeFile(exportFile, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${events.length} events to ${exportFile}\n`);
    return;
  }
  const json = hasFlag(args, "json");
  const text =
    events.length === 0
      ? "No audit events."
      : events
          .map(
            (event) =>
              `${event.at} ${event.actor.type} ${event.action} ${event.objectType}/${event.objectId}`,
          )
          .join("\n");
  printResult(text, { events }, json);
}
