/**
 * The console router.
 *
 * `taa serve` mounts this handler. The handler takes a plain
 * request description and returns a plain response, so it can be mounted by any
 * HTTP server and exercised in-process by the tests. It never imports the HTTP
 * module, the store or the gateway.
 *
 * Every page is server-rendered. Forms post to this handler and answer with a
 * 303; a request carrying `X-TAA-Enhance: 1` gets JSON instead, which is the
 * only difference JavaScript makes.
 */

import { timingSafeEqual } from "node:crypto";

import type {
  NotificationChannelConfig,
  Period,
  RequestState,
  Role,
  Rule,
  TeamPolicy,
} from "../contracts.ts";
import type {
  ConsoleActions,
  ConsoleAuth,
  ConsoleData,
  DecideInput,
  ListMode,
  RequestListFilter,
  Theme,
  Viewer,
} from "./data.ts";
import { ConsoleActionError } from "./data.ts";
import type { FlashMessage, PageContext } from "./layout.ts";
import { renderAudit } from "./pages/audit.ts";
import { renderError } from "./pages/error.ts";
import { renderLogin } from "./pages/login.ts";
import { renderMe } from "./pages/me.ts";
import { renderMember } from "./pages/member.ts";
import { renderModels } from "./pages/models.ts";
import { renderOverview } from "./pages/overview.ts";
import { renderRequests } from "./pages/requests.ts";
import { renderRules } from "./pages/rules.ts";
import { renderSetup } from "./pages/setup.ts";
import { CONSOLE_JS } from "./script.ts";
import { CONSOLE_CSS } from "./styles.ts";
import { parseUsageQuery, renderUsage, usageCsv, usageFileName } from "./usage/index.ts";

export interface ConsoleRequest {
  method: string;
  /** Path and query, for example `/requests?view=history`. */
  url: string;
  headers: Record<string, string | undefined>;
  /** Parsed `application/x-www-form-urlencoded` body for a POST. */
  form: URLSearchParams | null;
  cookies: Record<string, string>;
  /** The authenticated person, or null when no session matches. */
  session: Viewer | null;
  /** The client address, for the login failure limiter. */
  ip?: string;
}

export interface ConsoleResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ConsoleOptions {
  data: ConsoleData;
  actions: ConsoleActions;
  auth: ConsoleAuth;
  now?: () => Date;
  timeZone?: string;
  gatewayName?: string;
  /** Render `?simulate=loading|empty|error` states; only the fixture server sets this. */
  allowSimulation?: boolean;
}

export interface Console {
  handle(request: ConsoleRequest): Promise<ConsoleResponse>;
}

const NOTICES: Readonly<Record<string, string>> = {
  "request-approved": "Request approved. The key changes on the next reconcile.",
  "request-partly_approved": "Request partly approved. The key changes on the next reconcile.",
  "request-denied": "Request denied. The member can see the note.",
  "request-cancelled": "Request cancelled.",
  "limits-saved": "Limits saved. The key updates on the next reconcile.",
  "models-saved": "Allowed models saved.",
  "key-blocked": "Key blocked. A call is refused at the gateway.",
  "key-unblocked": "Key unblocked.",
  "rule-saved": "Rule saved.",
  "policy-saved": "Team policy saved.",
  "request-sent": "Request sent to your manager.",
  "grant-revoked": "Grant revoked. The key updates on the next reconcile.",
  "theme-saved": "Theme saved.",
  "member-enrolled": "Member enrolled. The key is shown once.",
};

const CHANNELS: ReadonlyArray<NotificationChannelConfig["channel"]> = [
  "teams",
  "slack",
  "email",
  "webhook",
  "log",
];

const REQUEST_STATES: ReadonlyArray<RequestState> = [
  "pending",
  "approved",
  "partly_approved",
  "denied",
  "expired",
  "cancelled",
];

const PERIODS: ReadonlyArray<Period> = ["daily", "weekly", "monthly"];
const ROLES: ReadonlyArray<Role> = ["admin", "manager", "member"];

function isTheme(value: string | undefined): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function isListMode(value: string | null): value is ListMode {
  return value === "loading" || value === "empty" || value === "error";
}

function response(
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): ConsoleResponse {
  return {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store", ...headers },
    body,
  };
}

function htmlResponse(body: string, status = 200): ConsoleResponse {
  return response(status, "text/html; charset=utf-8", body);
}

function redirect(location: string, cookie?: string): ConsoleResponse {
  const headers: Record<string, string> = { location };
  if (cookie !== undefined) headers["set-cookie"] = cookie;
  return response(303, "text/plain; charset=utf-8", `Redirecting to ${location}`, headers);
}

function jsonResponse(payload: unknown, status = 200): ConsoleResponse {
  return response(status, "application/json; charset=utf-8", JSON.stringify(payload));
}

function safePath(value: string | null, fallback: string): string {
  if (value === null || value === "") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

function withNotice(returnTo: string, notice: string): string {
  const url = new URL(returnTo, "http://console.local");
  url.searchParams.set("notice", notice);
  return `${url.pathname}${url.search}`;
}

function noticeFrom(query: URLSearchParams): string | null {
  const code = query.get("notice");
  if (code === null) return null;
  return NOTICES[code] ?? null;
}

function cookieTheme(value: string | undefined): Theme {
  return isTheme(value) ? value : "system";
}

function fieldText(form: URLSearchParams, name: string): string | null {
  const value = form.get(name);
  return value === null ? null : value.trim();
}

function fieldNumber(form: URLSearchParams, name: string): number | null {
  const value = form.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldInteger(form: URLSearchParams, name: string): number | null {
  const value = fieldNumber(form, name);
  if (value === null) return null;
  return Number.isInteger(value) ? value : null;
}

function minutesFromTime(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return fallback;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return Math.min(23, hours) * 60 + Math.min(59, minutes);
}

function parseSort(query: URLSearchParams): {
  key: "name" | "spend" | "used" | "status";
  direction: "asc" | "desc";
} {
  const rawKey = query.get("sort");
  const key =
    rawKey === "name" || rawKey === "spend" || rawKey === "used" || rawKey === "status"
      ? rawKey
      : "spend";
  const direction = query.get("dir") === "asc" ? "asc" : "desc";
  return { key, direction };
}

function parseFilter(query: URLSearchParams): RequestListFilter {
  const view = query.get("view") === "history" ? "history" : "inbox";
  const stateRaw = query.get("state");
  const state = REQUEST_STATES.includes(stateRaw as RequestState)
    ? (stateRaw as RequestState)
    : "all";
  const memberId = query.get("memberId");
  const text = query.get("q") ?? "";
  return {
    view,
    state,
    memberId: memberId === null || memberId === "" ? null : memberId,
    query: text.trim().slice(0, 120),
    limit: 50,
  };
}

function isEnhanced(request: ConsoleRequest): boolean {
  return request.headers["x-taa-enhance"] === "1";
}

function csrfOk(request: ConsoleRequest, viewer: Viewer): boolean {
  const presented = request.form?.get("_csrf") ?? "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(viewer.csrfToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createConsole(options: ConsoleOptions): Console {
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "Europe/Berlin";
  const gatewayName = options.gatewayName ?? "this control service";

  function contextFor(
    viewer: Viewer,
    theme: Theme,
    pathname: string,
    query: URLSearchParams,
    flash: FlashMessage | null,
    openRequests: number,
  ): PageContext {
    const rawMode = query.get("simulate");
    const mode: ListMode =
      options.allowSimulation === true && rawMode !== null && isListMode(rawMode)
        ? rawMode
        : "ready";
    return {
      viewer,
      theme,
      path: pathname,
      now: now(),
      timeZone,
      flash,
      mode,
      openRequests,
    };
  }

  function errorPage(
    viewer: Viewer,
    theme: Theme,
    status: number,
    title: string,
    message: string,
    retryHref: string,
  ): ConsoleResponse {
    const ctx = contextFor(viewer, theme, "/", new URLSearchParams(), null, 0);
    return htmlResponse(renderError({ ctx, status, title, message, retryHref }).value, status);
  }

  async function renderPage(
    viewer: Viewer,
    theme: Theme,
    pathname: string,
    query: URLSearchParams,
    flash: FlashMessage | null,
  ): Promise<ConsoleResponse> {
    if (viewer.role === "member" && pathname !== "/me" && pathname !== "/requests/count") {
      return redirect("/me");
    }
    const segments = pathname.split("/").filter(Boolean);
    const notice = noticeFrom(query);
    const flashMessage: FlashMessage | null =
      flash ?? (notice === null ? null : { kind: "success", message: notice });

    if (pathname === "/") {
      const [data, openRequests] = await Promise.all([
        options.data.overview(parseSort(query)),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(renderOverview({ ctx, data, sort: parseSort(query) }).value);
    }

    if (pathname === "/requests") {
      const filter = parseFilter(query);
      const id = query.get("id");
      const [requests, members, models, counts, openRequests] = await Promise.all([
        options.data.requests(filter),
        options.data.members(),
        options.data.modelCatalogue(),
        options.data.requestCounts(),
        options.data.openRequestCount(),
      ]);
      const detail = id === null ? null : await options.data.requestDetail(id);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(
        renderRequests({
          ctx,
          requests,
          members,
          models,
          detail,
          filter,
          counts,
          selectedId: detail?.request.id ?? null,
        }).value,
      );
    }

    if (segments[0] === "requests" && segments.length === 2 && segments[1] !== "count") {
      const id = segments[1] ?? "";
      const filter = parseFilter(query);
      const [requests, members, models, counts, openRequests, detail] = await Promise.all([
        options.data.requests(filter),
        options.data.members(),
        options.data.modelCatalogue(),
        options.data.requestCounts(),
        options.data.openRequestCount(),
        options.data.requestDetail(id),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      if (detail === null) {
        return htmlResponse(
          renderError({
            ctx,
            status: 404,
            title: "Request not found",
            message: "It may have been decided, cancelled or expired. The history keeps it.",
            retryHref: "/requests?view=history",
          }).value,
          404,
        );
      }
      return htmlResponse(
        renderRequests({ ctx, requests, members, models, detail, filter, counts, selectedId: id })
          .value,
      );
    }

    if (segments[0] === "members" && segments.length === 2) {
      const id = segments[1] ?? "";
      const [detail, models, openRequests] = await Promise.all([
        options.data.memberDetail(id),
        options.data.modelCatalogue(),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      if (detail === null) {
        return htmlResponse(
          renderError({
            ctx,
            status: 404,
            title: "Member not found",
            message: "That member is not in this team.",
            retryHref: "/",
          }).value,
          404,
        );
      }
      return htmlResponse(
        renderMember({ ctx, detail, models, revealedSecret: null, formError: null }).value,
      );
    }

    if (pathname === "/models") {
      const [data, openRequests] = await Promise.all([
        options.data.models(),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(renderModels({ ctx, data }).value);
    }

    if (pathname === "/rules") {
      const [rulesData, models, openRequests] = await Promise.all([
        options.data.rules(),
        options.data.modelCatalogue(),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(
        renderRules({
          ctx,
          rules: rulesData.rules,
          policy: rulesData.policy,
          models,
          formError: null,
        }).value,
      );
    }

    if (pathname === "/audit") {
      const limit = 50;
      const offset = Math.max(0, Number(query.get("offset") ?? "0") || 0);
      const filter = {
        actorId: query.get("actorId") === "" ? null : query.get("actorId"),
        objectType: query.get("objectType") === "" ? null : query.get("objectType"),
        objectId: query.get("objectId") === "" ? null : query.get("objectId"),
        from: query.get("from") === "" ? null : query.get("from"),
        to: query.get("to") === "" ? null : query.get("to"),
      };
      const [events, actors, openRequests] = await Promise.all([
        options.data.audit({ ...filter, limit, offset }),
        options.data.auditActors(),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(renderAudit({ ctx, events, actors, filter, limit, offset }).value);
    }

    if (pathname === "/setup") {
      const [data, openRequests] = await Promise.all([
        options.data.setup(),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(renderSetup({ ctx, data, reveal: null, formError: null }).value);
    }

    if (pathname === "/usage" || pathname === "/usage.csv") {
      const [report, openRequests] = await Promise.all([
        options.data.usage(parseUsageQuery(query)),
        options.data.openRequestCount(),
      ]);
      if (pathname === "/usage.csv") {
        return response(200, "text/csv; charset=utf-8", usageCsv(report), {
          "content-disposition": `attachment; filename="${usageFileName(report)}"`,
        });
      }
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      return htmlResponse(renderUsage({ ctx, report }).value);
    }

    if (segments[0] === "setup" && segments[1] === "bundle" && segments.length === 3) {
      const id = segments[2] ?? "";
      const bundle = await options.data.bundle(id);
      if (bundle === null) {
        const ctx = contextFor(viewer, theme, pathname, query, flashMessage, 0);
        return htmlResponse(
          renderError({
            ctx,
            status: 404,
            title: "Bundle not found",
            message: "That member does not exist in this team.",
            retryHref: "/setup",
          }).value,
          404,
        );
      }
      const safeName = bundle.filename.replaceAll(/[^A-Za-z0-9._-]/g, "_");
      return response(200, bundle.contentType, bundle.body, {
        "content-disposition": `attachment; filename="${safeName}"`,
      });
    }

    if (pathname === "/me") {
      const [data, openRequests] = await Promise.all([
        options.data.me(viewer),
        options.data.openRequestCount(),
      ]);
      const ctx = contextFor(viewer, theme, pathname, query, flashMessage, openRequests);
      if (data === null) {
        return htmlResponse(
          renderError({
            ctx,
            status: 404,
            title: "No allowance profile",
            message: "This account is not enrolled as a member with a budget.",
            retryHref: "/",
          }).value,
          404,
        );
      }
      return htmlResponse(renderMe({ ctx, data, formError: null }).value);
    }

    const ctx = contextFor(viewer, theme, pathname, query, flashMessage, 0);
    return htmlResponse(
      renderError({
        ctx,
        status: 404,
        title: "Page not found",
        message: "That page does not exist.",
        retryHref: "/",
      }).value,
      404,
    );
  }

  function loginResponse(
    theme: Theme,
    error: string | null,
    next: string,
    viewer: Viewer | null,
    status = 401,
  ): ConsoleResponse {
    return htmlResponse(
      renderLogin({ theme, error, next, viewer, gatewayName }).value,
      error === null ? 200 : status,
    );
  }

  async function handlePost(
    request: ConsoleRequest,
    viewer: Viewer,
    theme: Theme,
    pathname: string,
    query: URLSearchParams,
  ): Promise<ConsoleResponse> {
    const form = request.form ?? new URLSearchParams();
    const enhanced = isEnhanced(request);
    const returnTo = safePath(form.get("returnTo"), "/requests");

    if (
      viewer.role === "member" &&
      pathname !== "/me" &&
      !pathname.startsWith("/me/") &&
      pathname !== "/theme" &&
      pathname !== "/logout"
    ) {
      if (enhanced)
        return jsonResponse({ ok: false, message: "A member cannot use a manager form." }, 403);
      return errorPage(
        viewer,
        theme,
        403,
        "Not allowed",
        "A member cannot use a manager form.",
        "/me",
      );
    }

    if (!csrfOk(request, viewer)) {
      if (enhanced)
        return jsonResponse(
          { ok: false, message: "Your session is out of date. Reload the page." },
          403,
        );
      return errorPage(
        viewer,
        theme,
        403,
        "Session expired",
        "The form token did not match. Reload the page; nothing was changed.",
        returnTo,
      );
    }

    try {
      const segments = pathname.split("/").filter(Boolean);

      if (pathname === "/theme") {
        const value = form.get("theme");
        const chosen = isTheme(value ?? undefined) ? value : "system";
        const cookie =
          chosen === "system"
            ? "taa_theme=; Path=/; Max-Age=0; SameSite=Strict"
            : `taa_theme=${chosen}; Path=/; Max-Age=31536000; SameSite=Strict`;
        return redirect(withNotice(returnTo, "theme-saved"), cookie);
      }

      if (pathname === "/logout") {
        return redirect("/login", options.auth.logout());
      }

      if (segments[0] === "requests" && segments[2] === "decide" && segments.length === 3) {
        const id = segments[1] ?? "";
        const outcomeRaw = form.get("outcome");
        if (
          outcomeRaw !== "approved" &&
          outcomeRaw !== "partly_approved" &&
          outcomeRaw !== "denied"
        ) {
          throw new ConsoleActionError("Choose approve, partly approve or deny.", 400);
        }
        const decisionInput: DecideInput = {
          outcome: outcomeRaw,
          note: fieldText(form, "note"),
          amountUsd: fieldNumber(form, "amountUsd"),
          modelId: null,
          until: fieldText(form, "until"),
          permanent: form.get("permanent") === "1",
        };
        const receipt = await options.actions.decide(id, decisionInput);
        if (enhanced) {
          return jsonResponse({
            ok: true,
            message: receipt.message,
            removeSelector: `#request-${id}`,
            openRequests: await options.data.openRequestCount(),
          });
        }
        return redirect(withNotice(returnTo, `request-${outcomeRaw}`));
      }

      if (pathname === "/me/requests") {
        const kind = form.get("kind");
        if (kind !== "more_budget" && kind !== "model_unlock" && kind !== "suggestion") {
          throw new ConsoleActionError("Choose a request type.", 400);
        }
        const receipt = await options.actions.createRequest({
          kind,
          amountUsd: fieldNumber(form, "amountUsd"),
          modelId: fieldText(form, "modelId"),
          message: form.get("message") ?? "",
        });
        if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
        return redirect(withNotice(returnTo, "request-sent"));
      }

      if (pathname === "/setup/members") {
        const roleRaw = form.get("role");
        const role = ROLES.includes(roleRaw as Role) ? (roleRaw as Role) : "member";
        const periodRaw = form.get("period");
        const period = PERIODS.includes(periodRaw as Period) ? (periodRaw as Period) : "monthly";
        const receipt = await options.actions.enrolMember({
          displayName: form.get("displayName") ?? "",
          email: fieldText(form, "email"),
          role,
          budgetUsd: fieldNumber(form, "budgetUsd") ?? 0,
          period,
        });
        const [setupData, openRequests] = await Promise.all([
          options.data.setup(),
          options.data.openRequestCount(),
        ]);
        const ctx = contextFor(viewer, theme, pathname, query, null, openRequests);
        const enrolled = setupData.members.find((row) => row.member.id === receipt.memberId);
        return htmlResponse(
          renderSetup({
            ctx,
            data: setupData,
            reveal:
              receipt.secret === null || enrolled === undefined
                ? null
                : {
                    displayName: enrolled.member.displayName,
                    keyAlias: enrolled.member.keyAlias,
                    secret: receipt.secret,
                    memberId: enrolled.member.id,
                  },
            formError: null,
          }).value,
        );
      }

      if (segments[0] === "setup" && segments[1] === "bundle") {
        throw new ConsoleActionError("Bundles are read-only.", 400);
      }

      if (segments[0] === "members" && segments[1] !== undefined) {
        const memberId = segments[1];
        if (segments[2] === "grants" && segments[3] !== undefined && segments[4] === "revoke") {
          const grantId = segments[3];
          const receipt = await options.actions.revokeGrant(
            memberId,
            grantId,
            fieldText(form, "reason") ?? "Revoked by a manager.",
          );
          if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
          return redirect(withNotice(returnTo, "grant-revoked"));
        }
        if (segments[2] === "limits") {
          const periodRaw = form.get("period");
          const period = PERIODS.includes(periodRaw as Period) ? (periodRaw as Period) : "monthly";
          const receipt = await options.actions.updateLimits(memberId, {
            budgetUsd: fieldNumber(form, "budgetUsd") ?? 0,
            period,
            tokenCap: fieldInteger(form, "tokenCap"),
            rpm: fieldInteger(form, "rpm"),
            tpm: fieldInteger(form, "tpm"),
          });
          if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
          return redirect(withNotice(returnTo, "limits-saved"));
        }
        if (segments[2] === "models") {
          const modelIds = form
            .getAll("modelId")
            .filter((value): value is string => typeof value === "string");
          const receipt = await options.actions.updateModels(memberId, modelIds);
          if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
          return redirect(withNotice(returnTo, "models-saved"));
        }
        if (
          segments[2] === "key" &&
          (segments[3] === "block" || segments[3] === "unblock" || segments[3] === "rotate")
        ) {
          const action = segments[3] as "block" | "unblock" | "rotate";
          const receipt = await options.actions.keyAction(
            memberId,
            action,
            fieldText(form, "reason"),
          );
          if (action === "rotate") {
            const [detail, models, openRequests] = await Promise.all([
              options.data.memberDetail(memberId),
              options.data.modelCatalogue(),
              options.data.openRequestCount(),
            ]);
            const ctx = contextFor(
              viewer,
              theme,
              `/members/${memberId}`,
              query,
              null,
              openRequests,
            );
            if (detail === null) {
              return errorPage(
                viewer,
                theme,
                404,
                "Member not found",
                "That member is not in this team.",
                "/",
              );
            }
            return htmlResponse(
              renderMember({ ctx, detail, models, revealedSecret: receipt.secret, formError: null })
                .value,
            );
          }
          if (enhanced)
            return jsonResponse({ ok: true, message: receipt.message, secret: receipt.secret });
          return redirect(
            withNotice(returnTo, action === "block" ? "key-blocked" : "key-unblocked"),
          );
        }
      }

      if (segments[0] === "me" && segments[1] === "requests" && segments[3] === "cancel") {
        const id = segments[2] ?? "";
        const receipt = await options.actions.cancelRequest(id);
        if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
        return redirect(withNotice(returnTo, "request-cancelled"));
      }

      if (
        pathname === "/rules" ||
        (segments[0] === "rules" && segments[1] !== undefined && segments[1] !== "policy")
      ) {
        const { rules, policy } = await options.data.rules();
        const id = segments[0] === "rules" && segments[1] !== undefined ? segments[1] : "";
        const existing = rules.find((rule) => rule.id === id);
        const kind = form.get("kind") === "model_unlock" ? "model_unlock" : "budget_topup";
        const modelIds = (form.get("modelIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        const rule: Rule = {
          id: existing?.id ?? "",
          teamId: policy.teamId,
          name: form.get("name") ?? "",
          enabled: form.get("enabled") === "1",
          condition:
            kind === "budget_topup"
              ? {
                  kind: "budget_topup",
                  maxUsd: fieldNumber(form, "maxUsd") ?? 0,
                  oncePerDays: fieldInteger(form, "oncePerDays") ?? 0,
                }
              : {
                  kind: "model_unlock",
                  modelIds,
                  durationHours: fieldInteger(form, "durationHours") ?? 0,
                },
          createdAt: existing?.createdAt ?? now().toISOString(),
        };
        const receipt = await options.actions.saveRule(rule);
        if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
        return redirect(withNotice("/rules", "rule-saved"));
      }

      if (pathname === "/rules/policy") {
        const { policy } = await options.data.rules();
        const selectedChannels = new Set(form.getAll("channel"));
        const channels: NotificationChannelConfig[] = CHANNELS.map((channel) => {
          const existing = policy.notifications.find((entry) => entry.channel === channel);
          return {
            channel,
            config: existing?.config ?? {},
            enabled: channel === "log" ? true : selectedChannels.has(channel),
          };
        });
        const workingDays = form
          .getAll("workingDays")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7);
        const updated: TeamPolicy = {
          teamId: policy.teamId,
          offHours: {
            enabled: form.get("offHoursEnabled") === "1",
            timeZone: form.get("timeZone") ?? policy.offHours.timeZone,
            workingDays: [...new Set(workingDays)].sort((left, right) => left - right),
            startMinute: minutesFromTime(form.get("start"), policy.offHours.startMinute),
            endMinute: minutesFromTime(form.get("end"), policy.offHours.endMinute),
            holidays: (form.get("holidays") ?? "")
              .split(/[\s,]+/)
              .map((value) => value.trim())
              .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
            capUsd: fieldNumber(form, "offHoursCapUsd") ?? policy.offHours.capUsd,
          },
          thresholds: {
            softRatio: (fieldNumber(form, "softRatio") ?? policy.thresholds.softRatio * 100) / 100,
            graceRatio:
              (fieldNumber(form, "graceRatio") ?? policy.thresholds.graceRatio * 100) / 100,
          },
          unusualSpendMinUsd: fieldNumber(form, "unusualSpendMinUsd") ?? policy.unusualSpendMinUsd,
          notifications: channels,
          updatedAt: policy.updatedAt,
        };
        const receipt = await options.actions.savePolicy(updated);
        if (enhanced) return jsonResponse({ ok: true, message: receipt.message });
        return redirect(withNotice("/rules", "policy-saved"));
      }

      const fallbackCtx = contextFor(
        viewer,
        theme,
        pathname,
        query,
        null,
        await options.data.openRequestCount(),
      );
      return htmlResponse(
        renderError({
          ctx: fallbackCtx,
          status: 404,
          title: "Page not found",
          message: "That form target does not exist.",
          retryHref: "/",
        }).value,
        404,
      );
    } catch (error) {
      const message =
        error instanceof ConsoleActionError
          ? error.message
          : "The control service did not answer. Nothing was changed.";
      const status = error instanceof ConsoleActionError ? error.status : 500;
      if (enhanced) return jsonResponse({ ok: false, message }, status);
      const target = new URL(returnTo, "http://console.local");
      const page = await renderPage(
        viewer,
        theme,
        target.pathname,
        new URLSearchParams(target.search),
        { kind: "error", message },
      ).catch(() => null);
      if (page === null) {
        return errorPage(viewer, theme, status, "Not allowed", message, returnTo);
      }
      return page.status === 200 ? { ...page, status } : page;
    }
  }

  return {
    async handle(request: ConsoleRequest): Promise<ConsoleResponse> {
      const method = request.method.toUpperCase();
      const url = new URL(request.url, "http://console.local");
      const pathname = url.pathname;
      const query = url.searchParams;
      const theme = cookieTheme(request.cookies.taa_theme);

      if (method === "GET" && pathname === "/console.css") {
        return response(200, "text/css; charset=utf-8", CONSOLE_CSS, {
          "cache-control": "public, max-age=300",
        });
      }
      if (method === "GET" && pathname === "/console.js") {
        return response(200, "text/javascript; charset=utf-8", CONSOLE_JS, {
          "cache-control": "public, max-age=300",
        });
      }

      if (method === "GET" && pathname === "/login") {
        return loginResponse(theme, null, safePath(query.get("next"), "/"), request.session);
      }

      if (method === "POST" && pathname === "/login") {
        const form = request.form ?? new URLSearchParams();
        const result = await options.auth.login({
          email: form.get("email") ?? "",
          password: form.get("password") ?? "",
          memberKey: form.get("memberKey") ?? "",
          ip: request.ip ?? "unknown",
        });
        if (!result.ok || result.cookie === null) {
          return loginResponse(
            theme,
            result.message ?? "Sign-in failed.",
            safePath(form.get("next"), "/"),
            null,
            result.status ?? 401,
          );
        }
        return redirect(safePath(form.get("next"), "/"), result.cookie);
      }

      if (method === "GET" && pathname === "/requests/count") {
        if (request.session === null) return jsonResponse({ error: "unauthenticated" }, 401);
        if (request.session.role === "member") return jsonResponse({ open: 0 });
        return jsonResponse({ open: await options.data.openRequestCount() });
      }

      const viewer = request.session;
      if (viewer === null) {
        const next = `${pathname}${url.search}`;
        return redirect(`/login?next=${encodeURIComponent(safePath(next, "/"))}`);
      }

      if (method === "GET") {
        try {
          return await renderPage(viewer, theme, pathname, query, null);
        } catch {
          return errorPage(
            viewer,
            theme,
            500,
            "Something went wrong",
            "The control service did not answer. Nothing was changed; try again.",
            "/",
          );
        }
      }

      if (method === "POST") {
        return handlePost(request, viewer, theme, pathname, query);
      }

      return response(405, "text/plain; charset=utf-8", "Method not allowed", {
        allow: "GET, POST",
      });
    },
  };
}

export type {
  ConsoleActions,
  ConsoleAuth,
  ConsoleData,
  LoginResult,
  Theme,
  Viewer,
} from "./data.ts";
export { ConsoleActionError } from "./data.ts";
export { createFixtureConsole, FIXTURE_NOW, FIXTURE_TIME_ZONE } from "./fixtures.ts";
export { CONSOLE_CSS, CONSOLE_JS };
