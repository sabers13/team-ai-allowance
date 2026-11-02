import {
  type ActorType,
  type Decision,
  type DecisionOutcome,
  type Grant,
  type IsoDateTime,
  type Member,
  type Period,
  REQUEST_TTL_HOURS,
  type Request,
  type RequestContext,
  type RequestKind,
  type RequestState,
  type Role,
  type Usd,
} from "../contracts.ts";
import { DomainError, invalidInput, invalidState } from "./errors.ts";
import { addDays, addHours, parseUntil, periodEnd, toIso } from "./time.ts";

/**
 * The request state machine, pure.
 *
 * `pending` → `approved` | `partly_approved` | `denied` | `expired` | `cancelled`.
 * A decision creates at most one grant; the caller stores the three records and
 * writes the audit events in one transaction.
 */

export const MAX_MESSAGE_LENGTH = 2000;

export interface RequestContextInput {
  spendThisPeriodUsd: Usd;
  limitUsd: Usd;
  topModels: Array<{ modelId: string; spendUsd: Usd }>;
  last7DaysUsd: Usd;
}

export interface NewRequestInput {
  id: string;
  member: Member;
  kind: RequestKind;
  message: string;
  context: RequestContextInput;
  now: Date;
  amountUsd?: Usd;
  modelId?: string;
}

function cleanMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) invalidInput("A request needs a reason.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    invalidInput(`A request reason may be at most ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return trimmed;
}

function positiveUsd(value: Usd, field: string): Usd {
  if (!Number.isFinite(value) || value <= 0) invalidInput(`${field} must be a positive amount.`);
  return Math.round(value * 100) / 100;
}

export function buildRequest(input: NewRequestInput): Request {
  const message = cleanMessage(input.message);
  let amountUsd: Usd | null = null;
  let modelId: string | null = null;

  switch (input.kind) {
    case "more_budget":
      if (input.amountUsd === undefined) invalidInput("A budget request needs an amount.");
      amountUsd = positiveUsd(input.amountUsd, "amountUsd");
      break;
    case "model_unlock":
      if (input.modelId === undefined || input.modelId.trim().length === 0) {
        invalidInput("A model request needs a model id.");
      }
      modelId = input.modelId.trim();
      break;
    case "suggestion":
      break;
  }

  const context: RequestContext = {
    spendThisPeriodUsd: input.context.spendThisPeriodUsd,
    limitUsd: input.context.limitUsd,
    topModels: input.context.topModels,
    last7DaysUsd: input.context.last7DaysUsd,
  };

  return {
    id: input.id,
    memberId: input.member.id,
    teamId: input.member.teamId,
    kind: input.kind,
    amountUsd,
    modelId,
    message,
    state: "pending",
    context,
    createdAt: toIso(input.now),
    expiresAt: toIso(addHours(input.now, REQUEST_TTL_HOURS)),
    decidedAt: null,
  };
}

export interface Decider {
  /** `manager` or `admin` for a person; `rule` for an auto-approve rule. */
  type: ActorType;
  id: string;
  role: Role | "rule";
  source: "manager" | "rule";
  displayName?: string | null;
}

export interface DecisionInput {
  outcome: DecisionOutcome;
  note?: string | null;
  amountUsd?: Usd | null;
  modelId?: string | null;
  until?: string | null;
  permanent?: boolean;
}

export interface DecideOptions {
  now: Date;
  grantId: string;
  decisionId: string;
  /** The member's budget period, used for the default grant expiry. */
  budgetPeriod: Period;
}

export interface DecisionResult {
  request: Request;
  decision: Decision;
  grant: Grant | null;
}

const OUTCOME_STATE: Record<DecisionOutcome, RequestState> = {
  approved: "approved",
  partly_approved: "partly_approved",
  denied: "denied",
};

function grantExpiry(
  request: Request,
  options: DecideOptions,
  input: DecisionInput,
): IsoDateTime | null {
  if (input.permanent === true) {
    if (input.until !== undefined && input.until !== null && input.until.length > 0) {
      invalidInput("A grant cannot be both permanent and until a date.");
    }
    return null;
  }
  if (input.until !== undefined && input.until !== null && input.until.length > 0) {
    const until = parseUntil(input.until);
    if (until.getTime() <= options.now.getTime()) {
      invalidInput("The until date must be in the future.");
    }
    return toIso(until);
  }
  if (request.kind === "model_unlock") {
    return toIso(addHours(options.now, 24));
  }
  return toIso(periodEnd(options.budgetPeriod, options.now));
}

export function decideRequest(
  request: Request,
  input: DecisionInput,
  decider: Decider,
  options: DecideOptions,
): DecisionResult {
  if (request.state !== "pending") {
    invalidState(`Request ${request.id} is ${request.state}, not pending.`);
  }
  if (options.now.getTime() >= new Date(request.expiresAt).getTime()) {
    throw new DomainError("expired", `Request ${request.id} expired before a decision.`);
  }

  let grantedAmountUsd: Usd | null = null;
  let grantedModelId: string | null = null;

  if (input.outcome !== "denied") {
    switch (request.kind) {
      case "more_budget": {
        const requested = request.amountUsd;
        if (requested === null) invalidInput("This budget request has no amount.");
        const granted =
          input.amountUsd === undefined || input.amountUsd === null
            ? requested
            : positiveUsd(input.amountUsd, "amountUsd");
        if (input.outcome === "partly_approved") {
          if (granted >= requested) {
            invalidInput("A partial approval must grant less than the member asked for.");
          }
        } else if (granted !== requested) {
          invalidInput(
            "A full approval must grant exactly the requested amount; use partly_approved.",
          );
        }
        grantedAmountUsd = granted;
        break;
      }
      case "model_unlock": {
        if (input.outcome === "partly_approved") {
          invalidInput("A model unlock cannot be partly approved.");
        }
        const requested = request.modelId;
        if (requested === null) invalidInput("This model request has no model id.");
        if (input.modelId !== undefined && input.modelId !== null && input.modelId !== requested) {
          invalidInput("A decision may only unlock the model the member asked for.");
        }
        grantedModelId = requested;
        break;
      }
      case "suggestion":
        if (input.outcome === "partly_approved") {
          invalidInput("A suggestion cannot be partly approved.");
        }
        break;
    }
  }

  const state = OUTCOME_STATE[input.outcome];
  const decidedAt = toIso(options.now);
  const updated: Request = { ...request, state, decidedAt };

  let grant: Grant | null = null;
  if (grantedAmountUsd !== null || grantedModelId !== null) {
    grant = {
      id: options.grantId,
      memberId: request.memberId,
      scope: request.kind === "more_budget" ? "budget" : "model",
      amountUsd: grantedAmountUsd,
      modelId: grantedModelId,
      tokenCap: null,
      requestId: request.id,
      issuedBy: decider.type,
      issuedById: decider.id,
      startsAt: decidedAt,
      expiresAt: grantExpiry(request, options, input),
      revokedAt: null,
      createdAt: decidedAt,
    };
  }

  const decision: Decision = {
    id: options.decisionId,
    requestId: request.id,
    outcome: input.outcome,
    decidedById: decider.id,
    decidedByRole: decider.role,
    note: input.note === undefined || input.note === null ? null : input.note.trim(),
    grantedAmountUsd,
    grantedModelId,
    grantExpiresAt: grant?.expiresAt ?? null,
    grantId: grant?.id ?? null,
    source: decider.source,
    decidedAt,
  };

  return { request: updated, decision, grant };
}

export function cancelRequest(request: Request): Request {
  if (request.state !== "pending") {
    invalidState(`Request ${request.id} is ${request.state}, not pending.`);
  }
  return { ...request, state: "cancelled", decidedAt: null };
}

export function isRequestDue(request: Request, now: Date): boolean {
  return request.state === "pending" && now.getTime() >= new Date(request.expiresAt).getTime();
}

/** Expire a pending request that has reached its 72-hour deadline. */
export function expireRequest(request: Request): Request {
  if (request.state !== "pending") {
    invalidState(`Request ${request.id} is ${request.state}, not pending.`);
  }
  return { ...request, state: "expired", decidedAt: null };
}

/** The seven-day window used by the "once per 7 days" rule limit. */
export function withinDays(iso: IsoDateTime, now: Date, days: number): boolean {
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && at > addDays(now, -days).getTime();
}
