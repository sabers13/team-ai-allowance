/**
 * The LiteLLM admin client.
 *
 * It implements the frozen `GatewayClient` interface from `src/contracts.ts`
 * and adds the rest of the admin surface this project uses (users, team
 * membership, key reads). Every call maps a failure to a `GatewayError`.
 *
 * Credential rules, enforced by construction:
 *
 * - the master key lives only in the `Authorization` header of an outbound
 *   request and in this object's private field;
 * - a member secret is hashed with sha256 as soon as the gateway returns it,
 *   and only the hash is kept by any caller;
 * - no method logs, and every gateway-supplied message is redacted before it
 *   becomes an error message.
 */
import { createHash } from "node:crypto";

import type {
  ApiFormat,
  CreatedGatewayKey,
  CreateGatewayKeyInput,
  DesiredKeyState,
  GatewayBudgetDuration,
  GatewayClient,
  GatewayKeyRef,
  GatewaySpendRow,
  Role,
  SpendQuery,
  Usd,
} from "../contracts.ts";
import { GatewayError, mapHttpError, redactSecrets } from "./errors.ts";
import type {
  CreateUserInput,
  KeyRecord,
  TeamMemberPatch,
  TeamRecord,
  TeamSpendRow,
  UpdateUserPatch,
  UserRecord,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

export interface LiteLLMGatewayClientOptions {
  readonly baseUrl: string;
  readonly masterKey: string;
  readonly timeoutMs?: number;
  /** Injection point for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** LiteLLM team membership has two roles; our domain has three. */
export function toTeamRole(role: Role): "admin" | "user" {
  return role === "member" ? "user" : "admin";
}

function parseKeyRecord(value: unknown): KeyRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    keyAlias: asString(record.key_alias),
    keyHash: asString(record.token) ?? asString(record.hashed_key),
    teamId: asString(record.team_id),
    userId: asString(record.user_id),
    models: asStringArray(record.models),
    maxBudgetUsd: asNumber(record.max_budget),
    budgetDuration: asString(record.budget_duration),
    tpmLimit: asNumber(record.tpm_limit),
    rpmLimit: asNumber(record.rpm_limit),
    blocked: asBoolean(record.blocked),
    spendUsd: asNumber(record.spend) ?? 0,
  };
}

function parseTeamRecord(value: unknown): TeamRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const teamId = asString(record.team_id);
  if (teamId === null) return null;
  return {
    teamId,
    teamAlias: asString(record.team_alias),
    maxBudgetUsd: asNumber(record.max_budget),
    budgetDuration: asString(record.budget_duration),
    spendUsd: asNumber(record.spend) ?? 0,
    blocked: asBoolean(record.blocked),
  };
}

function parseUserRecord(value: unknown): UserRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const userId = asString(record.user_id);
  if (userId === null) return null;
  const teams = Array.isArray(record.teams)
    ? record.teams
        .map((team) => (typeof team === "string" ? team : asString(asRecord(team)?.team_id)))
        .filter((team): team is string => team !== null)
    : [];
  return {
    userId,
    userAlias: asString(record.user_alias),
    userEmail: asString(record.user_email),
    teams,
  };
}

function parseApiFormat(value: unknown): ApiFormat | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normal = value.toLowerCase();
  if (normal.includes("anthropic") || normal.includes("messages")) return "anthropic_messages";
  if (normal.includes("responses")) return "responses";
  if (normal.includes("chat") || normal.includes("completion")) return "chat_completions";
  return "unknown";
}

function parseSpendRow(value: unknown): GatewaySpendRow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const requestId = asString(record.request_id);
  const startedAt = asString(record.startTime) ?? asString(record.start_time);
  if (requestId === null || startedAt === null) return null;
  const apiFormat = parseApiFormat(record.call_type);
  return {
    requestId,
    keyHash: asString(record.api_key) ?? "",
    teamId: asString(record.team_id),
    userId: asString(record.user),
    model: asString(record.model_group) ?? asString(record.model) ?? "unknown",
    spendUsd: asNumber(record.spend) ?? 0,
    promptTokens: Math.trunc(asNumber(record.prompt_tokens) ?? 0),
    completionTokens: Math.trunc(asNumber(record.completion_tokens) ?? 0),
    totalTokens: Math.trunc(asNumber(record.total_tokens) ?? 0),
    startedAt,
    endedAt: asString(record.endTime) ?? asString(record.end_time),
    ...(apiFormat === undefined ? {} : { apiFormat }),
  };
}

function envelopeList(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record === null) return [];
  const list = record[key];
  return Array.isArray(list) ? list : [];
}

export class LiteLLMGatewayClient implements GatewayClient {
  private readonly baseUrl: string;
  private readonly masterKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LiteLLMGatewayClientOptions) {
    if (options.masterKey.trim().length === 0) {
      throw new GatewayError("unauthorized", "the gateway client needs a master key");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.masterKey = options.masterKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // -- transport ---------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.masterKey}`,
      accept: "application/json",
      "user-agent": "taa-gateway-client/0.1",
    };
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new GatewayError(
        "network_error",
        timedOut
          ? `The gateway did not answer within ${this.timeoutMs} ms`
          : "Could not reach the gateway",
        { cause: error },
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!response.ok) throw mapHttpError(response.status, null);
        throw new GatewayError("invalid_response", "The gateway returned a non-JSON body", {
          status: response.status,
        });
      }
    }

    if (!response.ok) throw mapHttpError(response.status, parsed);
    return (parsed ?? {}) as T;
  }

  // -- keys --------------------------------------------------------------

  private async generateKey(input: {
    keyAlias: string;
    teamId?: string | undefined;
    userId?: string | undefined;
    models: readonly string[];
    maxBudgetUsd: Usd;
    budgetDuration: GatewayBudgetDuration;
    tpmLimit: number | null;
    rpmLimit: number | null;
  }): Promise<CreatedGatewayKey> {
    const body: JsonObject = {
      key_alias: input.keyAlias,
      models: [...input.models],
      max_budget: input.maxBudgetUsd,
      budget_duration: input.budgetDuration,
      tpm_limit: input.tpmLimit,
      rpm_limit: input.rpmLimit,
    };
    if (input.teamId !== undefined) body.team_id = input.teamId;
    if (input.userId !== undefined) body.user_id = input.userId;

    const response = await this.request<JsonObject>("POST", "/key/generate", { body });
    const secret = asString(response.key);
    if (secret === null) {
      throw new GatewayError("invalid_response", "The gateway did not return a key secret");
    }
    return { keyAlias: input.keyAlias, keyHash: sha256Hex(secret), secret };
  }

  async createKey(input: CreateGatewayKeyInput): Promise<CreatedGatewayKey> {
    return this.generateKey(input);
  }

  async updateKey(ref: GatewayKeyRef, desired: DesiredKeyState): Promise<void> {
    await this.request<JsonObject>("POST", "/key/update", {
      body: {
        key_alias: ref.keyAlias,
        models: [...desired.models],
        max_budget: desired.maxBudgetUsd,
        budget_duration: desired.budgetDuration,
        tpm_limit: desired.tpmLimit,
        rpm_limit: desired.rpmLimit,
        blocked: desired.blocked,
      },
    });
  }

  async deleteKey(ref: GatewayKeyRef): Promise<void> {
    await this.request<JsonObject>("POST", "/key/delete", {
      body: { key_aliases: [ref.keyAlias] },
    });
  }

  async blockKey(ref: GatewayKeyRef): Promise<void> {
    await this.request<JsonObject>("POST", "/key/block", { body: { key: ref.keyHash } });
  }

  async unblockKey(ref: GatewayKeyRef): Promise<void> {
    await this.request<JsonObject>("POST", "/key/unblock", { body: { key: ref.keyHash } });
  }

  /**
   * Replace a member's secret.
   *
   * `/key/regenerate` exists in v1.105.1 but raises "Regenerating Virtual Keys
   * is an Enterprise feature" unless a premium licence is present (the gate is
   * in `key_management_endpoints.py` at the pinned tag). Rotation therefore
   * uses the open-source path: read the key's settings by alias, delete it and
   * generate a replacement with the same alias and settings. The member sees a
   * new secret; the old one stops working immediately.
   */
  async regenerateKey(ref: GatewayKeyRef): Promise<CreatedGatewayKey> {
    const current = await this.findKeyByAlias(ref.keyAlias);
    if (current === null) {
      throw new GatewayError("not_found", `No gateway key with alias ${ref.keyAlias}`);
    }
    if (current.teamId === null || current.userId === null) {
      throw new GatewayError(
        "invalid_request",
        `Key ${ref.keyAlias} has no team or user; rotate it through the control service instead`,
      );
    }
    const duration = parseBudgetDuration(current.budgetDuration);
    await this.deleteKey(ref);
    return this.generateKey({
      keyAlias: ref.keyAlias,
      teamId: current.teamId,
      userId: current.userId,
      models: current.models ?? [],
      maxBudgetUsd: current.maxBudgetUsd ?? 0,
      budgetDuration: duration,
      tpmLimit: current.tpmLimit,
      rpmLimit: current.rpmLimit,
    });
  }

  async getKeyInfo(ref: GatewayKeyRef): Promise<KeyRecord | null> {
    const response = await this.request<JsonObject>("GET", "/key/info", {
      query: { key: ref.keyHash },
    });
    return parseKeyRecord(response.info);
  }

  async listKeys(
    filter: { keyAlias?: string; teamId?: string; userId?: string; pageSize?: number } = {},
  ): Promise<KeyRecord[]> {
    const response = await this.request<unknown>("GET", "/key/list", {
      query: {
        key_alias: filter.keyAlias,
        team_id: filter.teamId,
        user_id: filter.userId,
        page: "1",
        size: String(filter.pageSize ?? DEFAULT_PAGE_SIZE),
        return_full_object: "true",
      },
    });
    const keys = envelopeList(response, "keys");
    return keys.map(parseKeyRecord).filter((key): key is KeyRecord => key !== null);
  }

  async findKeyByAlias(keyAlias: string): Promise<KeyRecord | null> {
    const keys = await this.listKeys({ keyAlias });
    return keys.find((key) => key.keyAlias === keyAlias) ?? null;
  }

  // -- teams -------------------------------------------------------------

  async createTeam(input: {
    name: string;
    monthlyBudgetUsd: Usd;
    modelIds: string[];
  }): Promise<string> {
    const response = await this.request<JsonObject>("POST", "/team/new", {
      body: {
        team_alias: input.name,
        max_budget: input.monthlyBudgetUsd,
        models: input.modelIds,
      },
    });
    const teamId = asString(response.team_id);
    if (teamId === null) {
      throw new GatewayError("invalid_response", "The gateway did not return a team id");
    }
    return teamId;
  }

  async updateTeam(
    teamId: string,
    patch: { name?: string; monthlyBudgetUsd?: Usd },
  ): Promise<void> {
    const body: JsonObject = { team_id: teamId };
    if (patch.name !== undefined) body.team_alias = patch.name;
    if (patch.monthlyBudgetUsd !== undefined) body.max_budget = patch.monthlyBudgetUsd;
    await this.request<JsonObject>("POST", "/team/update", { body });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.request<JsonObject>("POST", "/team/delete", { body: { team_ids: [teamId] } });
  }

  async getTeamInfo(teamId: string): Promise<TeamRecord | null> {
    const response = await this.request<JsonObject>("GET", "/team/info", {
      query: { team_id: teamId },
    });
    return parseTeamRecord(response.team_info ?? response);
  }

  async listTeams(): Promise<TeamRecord[]> {
    const response = await this.request<unknown>("GET", "/team/list");
    return envelopeList(response, "teams")
      .map(parseTeamRecord)
      .filter((team): team is TeamRecord => team !== null);
  }

  async blockTeam(teamId: string): Promise<void> {
    await this.request<JsonObject>("POST", "/team/block", { body: { team_id: teamId } });
  }

  async unblockTeam(teamId: string): Promise<void> {
    await this.request<JsonObject>("POST", "/team/unblock", { body: { team_id: teamId } });
  }

  async addTeamMember(teamId: string, userId: string, role: Role): Promise<void> {
    await this.request<JsonObject>("POST", "/team/member_add", {
      body: { team_id: teamId, member: { user_id: userId, role: toTeamRole(role) } },
    });
  }

  async updateTeamMember(teamId: string, userId: string, patch: TeamMemberPatch): Promise<void> {
    const body: JsonObject = { team_id: teamId, user_id: userId };
    if (patch.role !== undefined) body.role = patch.role;
    if (patch.maxBudgetInTeamUsd !== undefined) body.max_budget_in_team = patch.maxBudgetInTeamUsd;
    if (patch.budgetDuration !== undefined) body.budget_duration = patch.budgetDuration;
    if (patch.tpmLimit !== undefined) body.tpm_limit = patch.tpmLimit;
    if (patch.rpmLimit !== undefined) body.rpm_limit = patch.rpmLimit;
    await this.request<JsonObject>("POST", "/team/member_update", { body });
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.request<JsonObject>("POST", "/team/member_delete", {
      body: { team_id: teamId, user_id: userId },
    });
  }

  async teamSpendByUser(teamId: string): Promise<TeamSpendRow[]> {
    const response = await this.request<unknown>("GET", "/team/spend/by_user", {
      query: { team_id: teamId },
    });
    return envelopeList(response, "data")
      .map((row) => {
        const record = asRecord(row);
        if (record === null) return null;
        return {
          userId: asString(record.user_id) ?? asString(record.user),
          spendUsd: asNumber(record.spend) ?? 0,
        };
      })
      .filter((row): row is TeamSpendRow => row !== null);
  }

  // -- users -------------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<string> {
    const body: JsonObject = {
      user_id: input.userId,
      auto_create_key: false,
    };
    if (input.userAlias !== undefined) body.user_alias = input.userAlias;
    if (input.userEmail !== undefined) body.user_email = input.userEmail;
    if (input.teamId !== undefined) body.teams = [input.teamId];
    const response = await this.request<JsonObject>("POST", "/user/new", { body });
    return asString(response.user_id) ?? input.userId;
  }

  async updateUser(userId: string, patch: UpdateUserPatch): Promise<void> {
    const body: JsonObject = { user_id: userId };
    if (patch.userAlias !== undefined) body.user_alias = patch.userAlias;
    if (patch.userEmail !== undefined) body.user_email = patch.userEmail;
    if (patch.maxBudgetUsd !== undefined) body.max_budget = patch.maxBudgetUsd;
    if (patch.budgetDuration !== undefined) body.budget_duration = patch.budgetDuration;
    if (patch.models !== undefined) body.models = [...patch.models];
    await this.request<JsonObject>("POST", "/user/update", { body });
  }

  async getUserInfo(userId: string): Promise<UserRecord | null> {
    const response = await this.request<JsonObject>("GET", "/user/info", {
      query: { user_id: userId },
    });
    return parseUserRecord(response.user_info ?? response);
  }

  async listUsers(): Promise<UserRecord[]> {
    const response = await this.request<unknown>("GET", "/user/list");
    return envelopeList(response, "users")
      .map(parseUserRecord)
      .filter((user): user is UserRecord => user !== null);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request<JsonObject>("POST", "/user/delete", { body: { user_ids: [userId] } });
  }

  // -- spend -------------------------------------------------------------

  async listSpend(query: SpendQuery): Promise<GatewaySpendRow[]> {
    // `/spend/logs` parses `start_date`/`end_date` as `%Y-%m-%d` (the handler
    // calls strptime with that format), so send UTC dates and narrow the rows
    // to the exact timestamp window here.
    const startDate = utcDate(query.from);
    const endDate = utcDatePlusOneDay(query.to);
    const response = await this.request<unknown>("GET", "/spend/logs", {
      query: {
        start_date: startDate,
        end_date: endDate,
        summarize: "false",
        api_key: query.keyHash,
      },
    });
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    const rows = envelopeList(response, "data")
      .map(parseSpendRow)
      .filter((row): row is GatewaySpendRow => row !== null)
      .filter((row) => {
        const at = Date.parse(row.startedAt);
        return Number.isFinite(at) && at >= fromMs && at <= toMs;
      });
    return query.teamId === undefined ? rows : rows.filter((row) => row.teamId === query.teamId);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/health/liveliness");
      return true;
    } catch {
      return false;
    }
  }
}

/** Accept the durations the contract allows; anything else becomes `1d`. */
function parseBudgetDuration(value: string | null): GatewayBudgetDuration {
  return value === "7d" || value === "30d" || value === "1d" ? value : "1d";
}

/** Format an ISO timestamp as the UTC date the spend endpoint expects. */
function utcDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GatewayError("invalid_request", `Not a valid timestamp: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * The spend endpoint parses `end_date` as midnight UTC and compares `lte`, so
 * its last day would otherwise be excluded. Ask for the next date and narrow
 * to the exact timestamp in `listSpend`.
 */
function utcDatePlusOneDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GatewayError("invalid_request", `Not a valid timestamp: ${value}`);
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Re-exported so a caller can redact a message before logging it. */
export { redactSecrets };
