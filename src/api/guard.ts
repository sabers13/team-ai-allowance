/**
 * Authorisation helpers shared by the route groups.
 *
 * Role order is member < manager (own team only) < admin (the whole org).
 * Every route declares its minimum role; these helpers add the per-object
 * team checks that a role alone cannot express.
 */

import type { Principal } from "../auth/index.ts";
import type { Actor } from "./control.ts";
import { forbidden, unauthorized } from "./errors.ts";
import type { RequestContext } from "./router.ts";

export function requirePrincipal(context: RequestContext): Principal {
  if (context.principal === null) throw unauthorized();
  return context.principal;
}

export function actorOf(principal: Principal): Actor {
  return {
    memberId: principal.member.id,
    teamId: principal.member.teamId,
    role: principal.role,
    via: principal.kind,
  };
}

/**
 * The team a manager route acts on. A manager is pinned to their own team; an
 * admin may name another team with `?teamId=`, defaulting to their own.
 */
export function scopedTeamId(context: RequestContext, principal: Principal): string {
  const requested = context.query.get("teamId");
  if (principal.role === "admin") {
    return requested !== null && requested.length > 0 ? requested : principal.member.teamId;
  }
  if (requested !== null && requested.length > 0 && requested !== principal.member.teamId) {
    throw forbidden("A manager cannot act on another team.");
  }
  return principal.member.teamId;
}

/** Refuse an object that belongs to a team the caller may not touch. */
export function assertObjectTeam(principal: Principal, teamId: string): void {
  if (principal.role === "admin") return;
  if (principal.member.teamId !== teamId) {
    throw forbidden("A manager cannot act on another team.");
  }
}

/** Refuse an explicit team in a request body or path that is not the caller's. */
export function assertTeamParam(principal: Principal, teamId: string): void {
  if (principal.role === "admin") return;
  if (principal.member.teamId !== teamId) {
    throw forbidden("A manager cannot act on another team.");
  }
}
