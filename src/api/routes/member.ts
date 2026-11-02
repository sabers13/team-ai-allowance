/**
 * Member routes (`/api/me`).
 *
 * A member key, a member session, a manager or an admin may call these for
 * their own member. A manager key cannot read another member's allowance here.
 */

import type { RequestKind } from "../../contracts.ts";
import type { ApiDependencies } from "../deps.ts";
import { badRequest, notFound } from "../errors.ts";
import { actorOf, requirePrincipal } from "../guard.ts";
import type { Router } from "../router.ts";
import {
  enumValue,
  isoDateTime,
  objectBody,
  optionalNumber,
  optionalString,
  requiredString,
} from "../validate.ts";

const REQUEST_KINDS = [
  "more_budget",
  "model_unlock",
  "suggestion",
] as const satisfies readonly RequestKind[];

export function registerMemberRoutes(router: Router, deps: ApiDependencies): void {
  router.add("GET", "/api/me", "member", async (context) => {
    const principal = requirePrincipal(context);
    const me = await deps.control.getMe(principal.member.id);
    return {
      status: 200,
      body: {
        displayName: me.displayName,
        teamName: me.teamName,
        ...me.policy,
      },
    };
  });

  router.add("GET", "/api/me/requests", "member", async (context) => {
    const principal = requirePrincipal(context);
    const requests = await deps.control.listRequests({ memberId: principal.member.id });
    return { status: 200, body: requests };
  });

  router.add("POST", "/api/me/requests", "member", async (context) => {
    const principal = requirePrincipal(context);
    const body = objectBody(context.body);
    const kind = enumValue("kind", body.kind, REQUEST_KINDS);
    const message = requiredString(body, "message", { minLength: 1, maxLength: 2000 });
    const amountUsd = optionalNumber(body, "amountUsd", { min: 0.01, max: 10_000 }) ?? null;
    const modelId = optionalString(body, "modelId", { maxLength: 200 }) ?? null;

    if (kind === "more_budget" && amountUsd === null) {
      throw badRequest("amountUsd is required for a budget request.", { field: "amountUsd" });
    }
    if (kind === "model_unlock" && modelId === null) {
      throw badRequest("modelId is required for a model request.", { field: "modelId" });
    }

    const request = await deps.control.createRequest({
      memberId: principal.member.id,
      teamId: principal.member.teamId,
      kind,
      amountUsd,
      modelId,
      message,
    });
    return { status: 201, body: request };
  });

  router.add("POST", "/api/me/requests/:id/cancel", "member", async (context) => {
    const principal = requirePrincipal(context);
    const requestId = context.params.id;
    if (requestId === undefined) throw notFound("Request not found.");
    const request = await deps.control.getRequest(requestId);
    if (request === null || request.memberId !== principal.member.id) {
      throw notFound("Request not found.");
    }
    const cancelled = await deps.control.cancelRequest(actorOf(principal), requestId);
    return { status: 200, body: cancelled };
  });

  router.add("GET", "/api/me/usage", "member", async (context) => {
    const principal = requirePrincipal(context);
    const to = queryDate(context.query.get("to"), "to") ?? deps.clock.now().toISOString();
    const from =
      queryDate(context.query.get("from"), "from") ??
      new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(from) > Date.parse(to)) {
      throw badRequest("from must be before to.", { field: "from" });
    }
    const usage = await deps.control.listUsage({
      memberId: principal.member.id,
      teamId: principal.member.teamId,
      from,
      to,
    });
    return { status: 200, body: usage };
  });
}

function queryDate(value: string | null, field: string): string | undefined {
  if (value === null || value.length === 0) return undefined;
  return isoDateTime(field, value);
}
