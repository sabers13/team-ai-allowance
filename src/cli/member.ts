/**
 * Member CLI commands: `status`, `request`, `requests`.
 * Thin wrappers over the same API client the MCP tools use.
 */

import type { RequestState } from "../contracts.ts";
import {
  ApiClient,
  allowanceView,
  formatAllowance,
  formatRequests,
  loadManagerConfig,
  loadMemberConfig,
  sumSpend,
} from "../mcp/index.ts";
import { hasFlag, optionalFlag, parseArgs, requiredFlag, UsageError } from "./args.ts";
import { printResult } from "./output.ts";

function usageWindowDays(period: string): number {
  if (period === "daily") return 1;
  if (period === "monthly") return 30;
  return 7;
}

async function allowanceText(api: ApiClient): Promise<{ text: string; data: unknown }> {
  const me = await api.getMe();
  let spend: number;
  if (typeof me.spendUsd === "number") {
    spend = me.spendUsd;
  } else {
    const days = usageWindowDays(me.limits?.period ?? "weekly");
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    spend = sumSpend(await api.myUsage(from.toISOString(), to.toISOString()));
  }
  const view = allowanceView(me, spend);
  return {
    text: formatAllowance(view),
    data: {
      remainingUsd: view.remainingUsd,
      budgetUsd: view.budgetUsd,
      spendUsd: view.spendUsd,
      status: view.status,
      periodEndsAt: view.periodEndsAt,
      allowedModels: view.allowedModels,
    },
  };
}

export async function commandStatus(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args = parseArgs(argv);
  if (args.positionals.length > 0) throw new UsageError("taa status takes no arguments");
  const config = await loadMemberConfig(env);
  const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.key });
  const { text, data } = await allowanceText(api);
  printResult(text, data, hasFlag(args, "json"));
}

export async function commandRequest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args = parseArgs(argv);
  const [kind, ...rest] = args.positionals;
  const config = await loadMemberConfig(env);
  const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.key });
  const json = hasFlag(args, "json");

  if (kind === "more-budget" || kind === "budget") {
    const amount = Number(requiredFlag(args, "amount", "request more-budget"));
    if (!Number.isFinite(amount) || amount <= 0)
      throw new UsageError("taa request more-budget: --amount must be > 0");
    const until = optionalFlag(args, "until");
    const reason = requiredFlag(args, "reason", "request more-budget");
    let message = reason;
    if (until !== undefined) {
      const time = Date.parse(until);
      if (Number.isNaN(time))
        throw new UsageError(`taa request more-budget: --until "${until}" is not a date`);
      message = `${reason} (requested until ${new Date(time).toISOString().slice(0, 10)})`;
    }
    const request = await api.createRequest({ kind: "more_budget", amountUsd: amount, message });
    printResult("Request sent to your manager.", request, json);
    return;
  }

  if (kind === "model") {
    const modelId = rest[0];
    if (modelId === undefined || modelId === "")
      throw new UsageError("taa request model <modelId> --reason ...");
    const hoursRaw = optionalFlag(args, "hours");
    const hours = hoursRaw === undefined ? undefined : Number(hoursRaw);
    if (hoursRaw !== undefined && (hours === undefined || !Number.isFinite(hours) || hours <= 0)) {
      throw new UsageError("taa request model: --hours must be > 0");
    }
    const reason = requiredFlag(args, "reason", "request model");
    const message = hours === undefined ? reason : `${reason} (requested for ${hours} hours)`;
    const request = await api.createRequest({ kind: "model_unlock", modelId, message });
    printResult("Request sent to your manager.", request, json);
    return;
  }

  if (kind === "suggestion") {
    const reason = optionalFlag(args, "reason") ?? rest.join(" ");
    if (reason === "") throw new UsageError("taa request suggestion --reason <text>");
    const request = await api.createRequest({ kind: "suggestion", message: reason });
    printResult("Noted for your manager.", request, json);
    return;
  }

  throw new UsageError("taa request <more-budget|model|suggestion> ...");
}

const validStates: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "partly_approved",
  "denied",
  "expired",
  "cancelled",
]);

/** `taa requests`: own requests by default, the team inbox with `--team`. */
export async function commandRequests(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args = parseArgs(argv);
  const json = hasFlag(args, "json");
  const pending = hasFlag(args, "pending");
  const stateRaw = optionalFlag(args, "state");
  if (stateRaw !== undefined && !validStates.has(stateRaw)) {
    throw new UsageError(`taa requests: unknown --state "${stateRaw}"`);
  }
  const limitRaw = optionalFlag(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && (limit === undefined || !Number.isInteger(limit) || limit <= 0)) {
    throw new UsageError("taa requests: --limit must be a positive integer");
  }
  const state = (pending ? "pending" : stateRaw) as RequestState | undefined;

  if (hasFlag(args, "team")) {
    const config = await loadManagerConfig(env);
    const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.token });
    let requests = await api.teamRequests({ state, limit });
    if (state !== undefined) requests = requests.filter((r) => r.state === state);
    if (limit !== undefined) requests = requests.slice(0, limit);
    printResult(formatRequests(requests), { requests }, json);
    return;
  }

  const config = await loadMemberConfig(env);
  const api = new ApiClient({ baseUrl: config.baseUrl, auth: config.key });
  let requests = await api.listMyRequests();
  if (state !== undefined) requests = requests.filter((r) => r.state === state);
  if (limit !== undefined) requests = requests.slice(0, limit);
  printResult(formatRequests(requests), { requests }, json);
}
