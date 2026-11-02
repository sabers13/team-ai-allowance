/**
 * Admin routes (`/api/admin`).
 *
 * Admin is the only role that crosses team boundaries. Creating a member also
 * issues the gateway key (returned once) and, for manager/admin accounts,
 * stores an scrypt password hash. Neither the key nor the password is ever
 * returned again or written to a log.
 */

import { hashPassword, issueManagerToken, MIN_PASSWORD_LENGTH } from "../../auth/index.ts";
import type { Limits, Role } from "../../contracts.ts";
import { AUDIT_ACTIONS } from "../../core/index.ts";
import type { ApiDependencies } from "../deps.ts";
import { badRequest, notFound } from "../errors.ts";
import { actorOf, assertTeamParam, requirePrincipal } from "../guard.ts";
import { publicMember } from "../redact.ts";
import type { Router } from "../router.ts";
import {
  enumValue,
  objectBody,
  optionalNullableNumber,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
} from "../validate.ts";

const ROLES = ["member", "manager", "admin"] as const satisfies readonly Role[];

export function registerAdminRoutes(router: Router, deps: ApiDependencies): void {
  router.add("GET", "/api/admin/teams", "admin", async () => {
    const teams = await deps.control.listTeams();
    return { status: 200, body: teams };
  });

  router.add("POST", "/api/admin/teams", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const body = objectBody(context.body);
    const team = await deps.control.createTeam(actorOf(principal), {
      name: requiredString(body, "name", { minLength: 1, maxLength: 100 }),
      monthlyBudgetUsd: requiredNumber(body, "monthlyBudgetUsd", { min: 0, max: 10_000_000 }),
    });
    return { status: 201, body: team };
  });

  router.add("PATCH", "/api/admin/teams/:id", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = context.params.id;
    if (teamId === undefined) throw notFound("Team not found.");
    const existing = await deps.control.getTeam(teamId);
    if (existing === null) throw notFound("Team not found.");
    const body = objectBody(context.body);
    const patch: { name?: string; monthlyBudgetUsd?: number } = {};
    const name = optionalString(body, "name", { minLength: 1, maxLength: 100 });
    if (name !== undefined) patch.name = name;
    const monthlyBudgetUsd = optionalNumber(body, "monthlyBudgetUsd", { min: 0, max: 10_000_000 });
    if (monthlyBudgetUsd !== undefined) patch.monthlyBudgetUsd = monthlyBudgetUsd;
    if (patch.name === undefined && patch.monthlyBudgetUsd === undefined) {
      throw badRequest("No team fields supplied.");
    }
    const team = await deps.control.updateTeam(actorOf(principal), teamId, patch);
    return { status: 200, body: team };
  });

  router.add("DELETE", "/api/admin/teams/:id", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = context.params.id;
    if (teamId === undefined) throw notFound("Team not found.");
    const existing = await deps.control.getTeam(teamId);
    if (existing === null) throw notFound("Team not found.");
    await deps.control.deleteTeam(actorOf(principal), teamId);
    return { status: 200, body: { deleted: true } };
  });

  router.add("POST", "/api/admin/teams/:id/members", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = context.params.id;
    if (teamId === undefined) throw notFound("Team not found.");
    const team = await deps.control.getTeam(teamId);
    if (team === null) throw notFound("Team not found.");

    const body = objectBody(context.body);
    const displayName = requiredString(body, "displayName", { minLength: 1, maxLength: 100 });
    const role = enumValue("role", body.role, ROLES);
    const email = optionalString(body, "email", {
      minLength: 3,
      maxLength: 320,
      pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
      patternMessage: "email must look like name@example.com.",
    });
    const password = optionalString(body, "password", {
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: 200,
    });

    if (role !== "member") {
      if (email === undefined)
        throw badRequest("Manager and admin accounts need an email.", { field: "email" });
      if (password === undefined) {
        throw badRequest("Manager and admin accounts need a password.", { field: "password" });
      }
    }
    if (password !== undefined && email === undefined) {
      throw badRequest("A password needs an email.", { field: "email" });
    }
    if (password !== undefined && role === "member") {
      throw badRequest("A member signs in with their key, not a password.", { field: "password" });
    }

    const limits = parseLimits(body.limits);
    const passwordHash = password === undefined ? null : await hashPassword(password);
    const created = await deps.control.createMember(actorOf(principal), teamId, {
      displayName,
      email: email ?? null,
      role,
      ...(limits === undefined ? {} : { limits }),
    });
    if (passwordHash !== null && email !== undefined) {
      try {
        await deps.credentials.setPassword(created.id, email, passwordHash);
      } catch {
        throw new Error("member created but the password could not be stored");
      }
    }
    const { secret, ...member } = created;
    return { status: 201, body: { member: publicMember(member), secret } };
  });

  router.add("DELETE", "/api/admin/teams/:id/members/:memberId", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const teamId = context.params.id;
    const memberId = context.params.memberId;
    if (teamId === undefined || memberId === undefined) throw notFound("Member not found.");
    const member = await deps.control.getMember(memberId);
    if (member === null || member.teamId !== teamId) throw notFound("Member not found.");
    await deps.control.deleteMember(actorOf(principal), teamId, memberId);
    await deps.credentials.delete(memberId);
    await deps.managerTokens.revokeAllForMember(memberId, deps.clock.now().toISOString());
    return { status: 200, body: { deleted: true } };
  });

  router.add("POST", "/api/admin/manager-tokens", "admin", async (context) => {
    const principal = requirePrincipal(context);
    const body = objectBody(context.body);
    const memberId = requiredString(body, "memberId", { minLength: 1, maxLength: 100 });
    const label = optionalString(body, "label", { maxLength: 100 }) ?? null;
    const member = await deps.control.getMember(memberId);
    if (member === null) throw notFound("Member not found.");
    if (member.role !== "manager" && member.role !== "admin") {
      throw badRequest("Manager tokens require a manager or admin account.", { field: "memberId" });
    }
    const issued = await issueManagerToken(
      deps.managerTokens,
      { memberId: member.id, teamId: member.teamId, role: member.role, label },
      deps.clock,
    );
    await deps.control.recordAudit(actorOf(principal), {
      action: AUDIT_ACTIONS.managerTokenIssued,
      objectType: "manager_token",
      objectId: issued.record.id,
      before: null,
      after: {
        id: issued.record.id,
        memberId: member.id,
        teamId: member.teamId,
        role: member.role,
        label: issued.record.label,
        createdAt: issued.record.createdAt,
      },
      reason: null,
    });
    return {
      status: 201,
      body: {
        id: issued.record.id,
        token: issued.token,
        memberId: issued.record.memberId,
        label: issued.record.label,
        createdAt: issued.record.createdAt,
      },
    };
  });

  router.add(
    "GET",
    "/api/admin/teams/:id/members/:memberId/config-bundle",
    "admin",
    async (context) => {
      const principal = requirePrincipal(context);
      const teamId = context.params.id;
      const memberId = context.params.memberId;
      if (teamId === undefined || memberId === undefined) throw notFound("Member not found.");
      assertTeamParam(principal, teamId);
      const member = await deps.control.getMember(memberId);
      if (member === null || member.teamId !== teamId) throw notFound("Member not found.");
      const bundle = await deps.control.configBundle(teamId, memberId);
      return {
        status: 200,
        body: bundle,
        headers: {
          "Content-Disposition": `attachment; filename="taa-${member.id}-bundle.json"`,
        },
      };
    },
  );
}

function parseLimits(value: unknown): Limits | undefined {
  if (value === undefined || value === null) return undefined;
  const body = objectBody(value);
  return {
    budgetUsd: requiredNumber(body, "budgetUsd", { min: 0, max: 1_000_000 }),
    period: enumValue("period", body.period, ["daily", "weekly", "monthly"] as const),
    tokenCap:
      optionalNullableNumber(body, "tokenCap", {
        min: 1,
        max: 1_000_000_000,
        integer: true,
      }) ?? null,
    rpm: optionalNullableNumber(body, "rpm", { min: 1, max: 1_000_000, integer: true }) ?? null,
    tpm: optionalNullableNumber(body, "tpm", { min: 1, max: 100_000_000, integer: true }) ?? null,
  };
}
