/**
 * Minimal HTTP client for the control-service REST API. Used by the MCP servers and by the `taa` CLI. One small wrapper over
 * `fetch`, typed errors, and no secret ever written to a log.
 */

import type {
  AuditEvent,
  Decision,
  DecisionOutcome,
  EffectivePolicy,
  IsoDateTime,
  Member,
  Period,
  Request,
  RequestKind,
  RequestState,
  Team,
  UsageRow,
} from "../contracts.ts";

/** An API failure with a stable code and a sentence a person can act on. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the service could not be reached at all. */
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the request never reached the service (DNS, refused, timeout). */
  isNetwork(): boolean {
    return this.status === 0;
  }

  /** True when the service answered "no" (auth, role, limit, conflict). */
  isRefusal(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      this.status === 404 ||
      this.status === 409 ||
      this.status === 422 ||
      this.status === 429
    );
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly auth: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface CreateRequestInput {
  readonly kind: RequestKind;
  readonly amountUsd?: number | undefined;
  readonly modelId?: string | undefined;
  readonly message: string;
}

export interface DecideRequestInput {
  readonly outcome: DecisionOutcome;
  readonly note?: string | undefined;
  readonly amountUsd?: number | undefined;
  readonly modelId?: string | undefined;
  readonly until?: IsoDateTime | undefined;
  readonly permanent?: boolean | undefined;
}

export interface SetLimitsInput {
  readonly budgetUsd?: number | undefined;
  readonly period?: Period | undefined;
  readonly tokenCap?: number | null | undefined;
  readonly rpm?: number | null | undefined;
  readonly tpm?: number | null | undefined;
}

export interface TeamRequestsFilter {
  readonly state?: RequestState | undefined;
  readonly memberId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface AuditQuery {
  readonly actorId?: string | undefined;
  readonly objectType?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MemberDetail {
  readonly member: Member;
  readonly policy: EffectivePolicy;
  readonly limits: unknown;
  readonly grants: unknown[];
  readonly usage: UsageRow[];
}
export interface TeamOverview {
  readonly team: Team;
  readonly members: Array<{
    readonly member: Member;
    readonly policy: EffectivePolicy;
    readonly spendUsd: number;
  }>;
  readonly models: unknown[];
  readonly openRequests: Request[];
  readonly alerts: unknown[];
}

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * Thin JSON client over the control-service API. Auth is a bearer token
 * (member key or manager token); it travels in the `Authorization` header
 * and is never logged.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.auth}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.name : "fetch failed";
      throw new ApiError(0, "network", `cannot reach the control service (${detail})`);
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload as T;
    throw this.refusal(response.status, payload);
  }

  private refusal(status: number, payload: unknown): ApiError {
    if (payload !== null && typeof payload === "object" && "error" in payload) {
      const envelope = (payload as { error: { code?: unknown; message?: unknown } }).error;
      const code = typeof envelope.code === "string" ? envelope.code : "refused";
      const message =
        typeof envelope.message === "string" && envelope.message !== ""
          ? envelope.message
          : `the control service refused the request (HTTP ${status})`;
      return new ApiError(status, code, message);
    }
    return new ApiError(
      status,
      "refused",
      `the control service refused the request (HTTP ${status})`,
    );
  }

  // -- member routes -------------------------------------------------------

  getMe(): Promise<
    EffectivePolicy & {
      displayName: string;
      teamName: string;
      status: string;
      /** The service may include the current period spend to save a second call. */
      spendUsd?: number | undefined;
    }
  > {
    return this.request("GET", "/api/me");
  }

  listMyRequests(): Promise<Request[]> {
    return this.request("GET", "/api/me/requests");
  }

  createRequest(input: CreateRequestInput): Promise<Request> {
    return this.request("POST", "/api/me/requests", {
      kind: input.kind,
      ...(input.amountUsd === undefined ? {} : { amountUsd: input.amountUsd }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      message: input.message,
    });
  }

  cancelRequest(requestId: string): Promise<Request> {
    return this.request("POST", `/api/me/requests/${encodeURIComponent(requestId)}/cancel`);
  }

  myUsage(from: string, to: string): Promise<UsageRow[]> {
    return this.request("GET", `/api/me/usage${encodeQuery({ from, to })}`);
  }

  postDoctorReport(report: unknown): Promise<void> {
    return this.request("POST", "/api/me/doctor", report);
  }

  // -- manager routes ------------------------------------------------------

  teamOverview(): Promise<TeamOverview> {
    return this.request("GET", "/api/team/overview");
  }

  teamUsage(from: string, to: string): Promise<UsageRow[]> {
    return this.request("GET", `/api/team/usage${encodeQuery({ from, to })}`);
  }

  teamRequests(filter?: TeamRequestsFilter): Promise<Request[]> {
    return this.request(
      "GET",
      `/api/team/requests${encodeQuery({
        state: filter?.state,
        memberId: filter?.memberId,
        limit: filter?.limit,
      })}`,
    );
  }

  decideRequest(
    requestId: string,
    input: DecideRequestInput,
  ): Promise<{
    request: Request;
    decision: Decision;
    grant: unknown;
  }> {
    return this.request("POST", `/api/team/requests/${encodeURIComponent(requestId)}/decide`, {
      outcome: input.outcome,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.amountUsd === undefined ? {} : { amountUsd: input.amountUsd }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.permanent === undefined ? {} : { permanent: input.permanent }),
    });
  }

  memberDetail(memberId: string): Promise<MemberDetail> {
    return this.request("GET", `/api/team/members/${encodeURIComponent(memberId)}`);
  }

  setMemberLimits(
    memberId: string,
    patch: SetLimitsInput,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    return this.request("PATCH", `/api/team/members/${encodeURIComponent(memberId)}/limits`, patch);
  }

  setMemberModels(
    memberId: string,
    modelIds: string[],
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    return this.request("PATCH", `/api/team/members/${encodeURIComponent(memberId)}/models`, {
      modelIds,
    });
  }

  blockMember(
    memberId: string,
    reason: string,
  ): Promise<{ member: Member; policy: EffectivePolicy }> {
    return this.request("POST", `/api/team/members/${encodeURIComponent(memberId)}/key/block`, {
      reason,
    });
  }

  unblockMember(memberId: string): Promise<{ member: Member; policy: EffectivePolicy }> {
    return this.request("POST", `/api/team/members/${encodeURIComponent(memberId)}/key/unblock`);
  }

  audit(filter?: AuditQuery): Promise<AuditEvent[]> {
    return this.request(
      "GET",
      `/api/team/audit${encodeQuery({
        actorId: filter?.actorId,
        objectType: filter?.objectType,
        from: filter?.from,
        to: filter?.to,
        limit: filter?.limit,
      })}`,
    );
  }
}

/** Spend summed over usage rows, in USD. */
export function sumSpend(rows: readonly UsageRow[]): number {
  return rows.reduce((total, row) => total + row.costUsd, 0);
}
