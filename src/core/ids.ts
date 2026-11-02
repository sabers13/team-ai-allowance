import { randomUUID } from "node:crypto";

/**
 * Ids are injectable so a test can assert an exact audit trail. Production uses
 * random UUIDs with a readable prefix; nothing depends on sort order.
 */
export interface IdSource {
  next(prefix: string): string;
}

export function randomIds(): IdSource {
  return {
    next: (prefix) => `${prefix}_${randomUUID()}`,
  };
}

/** Deterministic ids for tests: `req_1`, `req_2`, … */
export function sequentialIds(start = 1): IdSource {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const value = counters.get(prefix) ?? start;
      counters.set(prefix, value + 1);
      return `${prefix}_${value}`;
    },
  };
}

export const ID_PREFIX = {
  team: "team",
  member: "mem",
  request: "req",
  grant: "grn",
  decision: "dec",
  rule: "rule",
  audit: "aud",
  usage: "use",
} as const;
