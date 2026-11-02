import type { ActorType, AuditActor, AuditEvent, AuditId, Clock } from "../contracts.ts";
import type { IdSource } from "./ids.ts";
import { toIso } from "./time.ts";

/**
 * The audit log is append-only. This module builds the events; the store
 * refuses UPDATE and DELETE on its audit table with SQLite triggers.
 */

export const AUDIT_ACTIONS = {
  requestCreated: "request.created",
  requestDecided: "request.decided",
  requestExpired: "request.expired",
  requestCancelled: "request.cancelled",
  grantIssued: "grant.issued",
  grantRevoked: "grant.revoked",
  grantExpired: "grant.expired",
  keyStateApplied: "key.state_applied",
  keyStateFailed: "key.state_failed",
  ruleUpserted: "rule.upserted",
  ruleDeleted: "rule.deleted",
  limitsUpdated: "limits.updated",
  modelsUpdated: "member.models_updated",
  teamPolicyUpdated: "team.policy_updated",
  memberBlocked: "member.blocked",
  memberUnblocked: "member.unblocked",
  managerTokenIssued: "manager_token.issued",
  notificationSent: "notification.sent",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export function makeActor(
  type: ActorType,
  id: string | null = null,
  displayName: string | null = null,
): AuditActor {
  return { type, id, displayName };
}

export const SYSTEM_ACTOR: AuditActor = makeActor("system", "control-service", "Control service");
export const RECONCILER_ACTOR: AuditActor = makeActor("reconciler", "reconciler", "Reconciler");
export const RULE_ACTOR = (ruleId: string): AuditActor => makeActor("rule", ruleId, null);

export interface AuditRecordInput {
  actor: AuditActor;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason?: string | null;
  at: Date;
}

/** Strip values JSON cannot hold and deep-copy, so a later mutation cannot edit history. */
export function normaliseAuditValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

const HIDDEN_AUDIT_FIELDS = new Set(["keyHash"]);

/**
 * Remove credential material from an audit payload.
 *
 * A member row carries `keyHash`; the rest of the API strips it, and
 * Keys are stored as SHA-256 hashes only. The audit log is not a
 * second place to publish that hash, so it never enters `before` or `after`.
 */
export function stripAuditSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripAuditSecrets(item));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (HIDDEN_AUDIT_FIELDS.has(key)) continue;
    out[key] = stripAuditSecrets(item);
  }
  return out;
}

export function makeAuditEvent(input: AuditRecordInput, id: AuditId): AuditEvent {
  return {
    id,
    at: toIso(input.at),
    actor: input.actor,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    before: stripAuditSecrets(normaliseAuditValue(input.before)),
    after: stripAuditSecrets(normaliseAuditValue(input.after)),
    reason: input.reason === undefined || input.reason === null ? null : input.reason,
  };
}

export interface AuditSink {
  appendAudit(event: AuditEvent): Promise<void>;
}

/** Writes one event per call; the id source makes a test's trail exact. */
export class AuditTrail {
  private readonly sink: AuditSink;
  private readonly ids: IdSource;
  private readonly clock: Clock;

  constructor(sink: AuditSink, ids: IdSource, clock: Clock) {
    this.sink = sink;
    this.ids = ids;
    this.clock = clock;
  }

  async record(input: Omit<AuditRecordInput, "at"> & { at?: Date }): Promise<AuditEvent> {
    const event = makeAuditEvent(
      { ...input, at: input.at ?? this.clock.now() },
      this.ids.next("aud"),
    );
    await this.sink.appendAudit(event);
    return event;
  }
}
