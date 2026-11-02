import type { Decision, Member, ModelEntry, Request } from "../../contracts.ts";
import { emptyState, listBlock, tabs } from "../components.ts";
import type { PageContext, RequestDetail, RequestListFilter } from "../data.ts";
import { dateTime, initials, relative, usd } from "../format.ts";
import { type Html, html, raw } from "../html.ts";
import { modelName, requestKindLabel, requestStateLabel, requestSubject } from "../labels.ts";
import { layout } from "../layout.ts";
import { requestStateTone } from "../status.ts";

export interface RequestsPageInput {
  ctx: PageContext;
  requests: Request[];
  members: Member[];
  models: ModelEntry[];
  detail: RequestDetail | null;
  filter: RequestListFilter;
  counts: { inbox: number; history: number };
  selectedId: string | null;
}

function statePill(state: Request["state"]): Html {
  return html`<span class="pill pill--${requestStateTone(state)}">${requestStateLabel(state)}</span>`;
}

function quickActions(request: Request, ctx: PageContext): Html {
  if (request.state !== "pending" || ctx.viewer.role === "member") return html``;
  const action = `/requests/${request.id}/decide`;
  return html`<div class="quick-actions">
    <form method="post" action="${action}" data-enhance data-region>
      <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
      <input type="hidden" name="returnTo" value="/requests">
      <input type="hidden" name="outcome" value="approved">
      <button class="button button--primary button--sm button--block" type="submit" aria-label="Approve this request">Approve</button>
    </form>
    <form method="post" action="${action}" data-enhance data-region>
      <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
      <input type="hidden" name="returnTo" value="/requests">
      <input type="hidden" name="outcome" value="denied">
      <button class="button button--danger button--sm button--block" type="submit" aria-label="Deny this request">Deny</button>
    </form>
  </div>`;
}

function requestCard(request: Request, input: RequestsPageInput): Html {
  const { ctx, selectedId, filter } = input;
  const member = input.members.find((candidate) => candidate.id === request.memberId);
  const detailHref =
    filter.view === "history" ? `/requests/${request.id}?view=history` : `/requests/${request.id}`;
  return html`<li class="request-card${selectedId === request.id ? " request-card--selected" : ""}" id="request-${request.id}" data-region>
    <div class="request-card__top">
      <span class="avatar" aria-hidden="true">${initials(member?.displayName ?? "Unknown")}</span>
      <span class="request-card__name">
        <a class="request-card__link" href="${detailHref}">${member?.displayName ?? request.memberId}</a>
      </span>
      <span style="margin-left: auto">${statePill(request.state)}</span>
    </div>
    <p class="request-card__meta">
      ${requestKindLabel(request.kind)} · ${requestSubject(request)} ·
      <span title="${request.createdAt}">${relative(request.createdAt, ctx.now)}</span>
    </p>
    <p class="request-card__reason">${request.message.length > 120 ? `${request.message.slice(0, 119)}…` : request.message}</p>
    ${quickActions(request, ctx)}
  </li>`;
}

function decisionsList(decisions: Decision[], timeZone: string, models: ModelEntry[]): Html {
  if (decisions.length === 0) return html`<p class="muted small">No decision recorded yet.</p>`;
  return html`<ul class="alerts" aria-label="Decisions">
    ${decisions.map(
      (decision) => html`<li class="alerts__item">
        <span>
          <strong class="small">${requestStateLabel(decision.outcome)}</strong>
          <span class="muted small"> by ${decision.decidedByRole === "rule" ? "a rule" : "a manager"} on ${dateTime(decision.decidedAt, timeZone)}</span>
          ${decision.note === null ? "" : html`<span class="detail__message small">${decision.note}</span>`}
          ${
            decision.grantedAmountUsd === null
              ? ""
              : html`<span class="muted small"> · granted ${usd(decision.grantedAmountUsd)}</span>`
          }
          ${
            decision.grantedModelId === null
              ? ""
              : html`<span class="muted small"> · unlocked ${modelName(models, decision.grantedModelId)}</span>`
          }
        </span>
      </li>`,
    )}
  </ul>`;
}

function decisionForm(
  detail: RequestDetail,
  ctx: PageContext,
  kind: "approve" | "deny" | "partly",
): Html {
  const request = detail.request;
  const id = `${kind}-${request.id}`;
  const action = `/requests/${request.id}/decide`;
  const outcome = kind === "partly" ? "partly_approved" : kind === "deny" ? "denied" : "approved";
  const noteId = `${kind}-note-${request.id}`;
  const untilId = `${kind}-until-${request.id}`;
  const hidden = html`<input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
    <input type="hidden" name="returnTo" value="/requests/${request.id}">
    <input type="hidden" name="outcome" value="${outcome}">`;

  const amount =
    kind === "partly"
      ? html`<div class="field">
          <label class="field__label" for="partly-amount-${request.id}">Amount to grant</label>
          <p class="field__hint" id="partly-amount-hint-${request.id}">The member asked for ${usd(request.amountUsd ?? 0)}. A lower amount is a partial approval.</p>
          <input id="partly-amount-${request.id}" name="amountUsd" type="number" inputmode="decimal" min="0.01" step="0.01" value="${request.amountUsd ?? ""}" required>
        </div>`
      : html``;

  const until =
    kind === "deny"
      ? html``
      : html`<div class="field">
          <label class="field__label" for="${untilId}">Until <span class="field__optional">(optional)</span></label>
          <p class="field__hint" id="${untilId}-hint">Leave empty to apply until the end of the current period.</p>
          <input id="${untilId}" name="until" type="date">
        </div>`;

  const permanent =
    kind === "deny"
      ? html``
      : html`<div class="check">
          <input id="permanent-${request.id}-${kind}" name="permanent" type="checkbox" value="1">
          <label class="check__label" for="permanent-${request.id}-${kind}">Permanent until revoked</label>
        </div>`;

  const noteLabel = kind === "deny" ? "Reason for the member" : "Note for the member";
  const noteHint =
    kind === "deny"
      ? "The member sees this note. Say what to do next."
      : "Optional. The member sees this note.";

  return html`<form id="${id}" method="post" action="${action}" data-enhance data-region>
    ${hidden}
    ${amount}
    ${until}
    ${permanent}
    <div class="field">
      <label class="field__label" for="${noteId}">${noteLabel} <span class="field__optional">(optional)</span></label>
      <p class="field__hint" id="${noteId}-hint">${noteHint}</p>
      <textarea id="${noteId}" name="note" rows="2"></textarea>
    </div>
    <div class="form-actions form-actions--end detail-actions-inline">
      <button class="button ${kind === "deny" ? "button--danger" : "button--primary"}" type="submit">
        ${kind === "partly" ? "Approve partly" : kind === "deny" ? "Deny request" : "Approve request"}
      </button>
    </div>
  </form>`;
}

function requestDetailPanel(detail: RequestDetail, input: RequestsPageInput): Html {
  const { ctx, models } = input;
  const request = detail.request;
  const context = request.context;
  const pending = request.state === "pending";
  const canDecide = pending && ctx.viewer.role !== "member";
  const backHref = input.filter.view === "history" ? "/requests?view=history" : "/requests";

  const hint =
    detail.hint === null
      ? ""
      : html`<p class="detail__hint"><strong>Cheaper option:</strong> ${detail.hint}</p>`;

  const actionbar = canDecide
    ? html`<div class="actionbar" aria-label="Decide this request">
        <button class="button button--primary" type="submit" form="approve-${request.id}">Approve</button>
        <button class="button button--danger" type="submit" form="deny-${request.id}">Deny</button>
      </div>`
    : html``;

  return html`<section class="card request-detail" id="detail" aria-labelledby="request-detail-title">
    <header class="card__header">
      <div class="card__titles">
        <p class="xs muted"><a class="detail-back" href="${backHref}">← Back to ${input.filter.view === "history" ? "history" : "inbox"}</a></p>
        <h2 class="card__title" id="request-detail-title">${detail.member.displayName} · ${requestKindLabel(request.kind)}</h2>
        <p class="card__subtitle">${requestSubject(request)} · created ${dateTime(request.createdAt, ctx.timeZone)} · expires ${dateTime(request.expiresAt, ctx.timeZone)}</p>
      </div>
      ${statePill(request.state)}
    </header>
    <div class="card__body">
      <p class="detail__message">${request.message}</p>
      ${hint}
      <div class="context-grid">
        <div class="metric">
          <p class="metric__label">Spend this period</p>
          <p class="metric__value">${usd(context.spendThisPeriodUsd)}</p>
          <p class="metric__sub">of ${usd(context.limitUsd)}</p>
        </div>
        <div class="metric">
          <p class="metric__label">Last 7 days</p>
          <p class="metric__value">${usd(context.last7DaysUsd)}</p>
        </div>
        <div class="metric">
          <p class="metric__label">Top models</p>
          <p class="metric__sub">${
            context.topModels.length === 0
              ? "No usage yet"
              : context.topModels
                  .map((row) => `${modelName(models, row.modelId)} ${usd(row.spendUsd)}`)
                  .join(" · ")
          }</p>
        </div>
      </div>

      ${
        canDecide
          ? html`<div class="decision-box">
            <h3>Decide</h3>
            <div class="decision-outcome">
              ${decisionForm(detail, ctx, "approve")}
              ${decisionForm(detail, ctx, "deny")}
              <details class="disclosure">
                <summary>Approve a smaller amount or a shorter window</summary>
                ${decisionForm(detail, ctx, "partly")}
              </details>
            </div>
          </div>`
          : html`<div class="decision-box">
            <h3>Decision</h3>
            ${decisionsList(detail.decisions, ctx.timeZone, models)}
          </div>`
      }
      ${actionbar}
    </div>
  </section>`;
}

function filterForm(input: RequestsPageInput): Html {
  const { filter, members } = input;
  const history = filter.view === "history";
  return html`<form class="filter-bar" method="get" action="/requests" role="search" aria-label="Filter requests">
    ${history ? raw('<input type="hidden" name="view" value="history">') : ""}
    <div class="field">
      <label class="field__label" for="filter-q">Search</label>
      <input id="filter-q" name="q" type="search" value="${filter.query}" placeholder="Member, reason or id">
    </div>
    <div class="field">
      <label class="field__label" for="filter-member">Member</label>
      <select id="filter-member" name="memberId">
        <option value="">All members</option>
        ${members.map(
          (member) =>
            html`<option value="${member.id}"${raw(filter.memberId === member.id ? " selected" : "")}>${member.displayName}</option>`,
        )}
      </select>
    </div>
    ${
      history
        ? html`<div class="field">
          <label class="field__label" for="filter-state">State</label>
          <select id="filter-state" name="state">
            ${(
              ["all", "approved", "partly_approved", "denied", "expired", "cancelled"] as const
            ).map(
              (state) =>
                html`<option value="${state}"${raw(filter.state === state ? " selected" : "")}>${state === "all" ? "All decided" : requestStateLabel(state)}</option>`,
            )}
          </select>
        </div>`
        : ""
    }
    <div class="field">
      <span class="field__label">&nbsp;</span>
      <div class="row">
        <button class="button button--secondary" type="submit">Filter</button>
        <a class="button button--quiet" href="${history ? "/requests?view=history" : "/requests"}">Clear</a>
      </div>
    </div>
  </form>`;
}

export function renderRequests(input: RequestsPageInput): Html {
  const { ctx, filter, requests, detail } = input;
  const history = filter.view === "history";
  const filtered =
    filter.query !== "" || filter.memberId !== null || (history && filter.state !== "all");

  const listTitle = history ? "History" : "Inbox";
  const empty = filtered
    ? emptyState({
        title: "No requests match these filters",
        body: "Widen the filters to see more.",
        actionHref: history ? "/requests?view=history" : "/requests",
        actionLabel: "Clear filters",
      })
    : emptyState({
        title: history ? "No decided requests yet" : "No open requests",
        body: history
          ? "Decisions appear here after a manager approves, partly approves or denies a request."
          : "A member can ask for more budget or a model from the CLI or from My allowance. New requests appear here.",
      });

  const list = listBlock({
    mode: ctx.mode,
    isEmpty: requests.length === 0,
    ready: html`<ul class="request-list" aria-label="${listTitle} requests">${requests.map((request) => requestCard(request, input))}</ul>`,
    empty,
    retryHref: history ? "/requests?view=history" : "/requests",
    loadingLabel: "Loading requests…",
  });

  const listCard = html`<section class="card request-list-card" aria-labelledby="request-list-title">
    <header class="card__header">
      <div class="card__titles">
        <h2 class="card__title" id="request-list-title">${listTitle}</h2>
        <p class="card__subtitle">${history ? `${input.counts.history} decided` : `${input.counts.inbox} waiting for a decision`}</p>
      </div>
    </header>
    <div class="card__body">
      ${filterForm(input)}
      ${list}
    </div>
  </section>`;

  const detailPanel =
    detail === null
      ? html`<section class="card request-detail request-detail--empty" id="detail" aria-labelledby="request-detail-title">
          <h2 class="card__title" id="request-detail-title">Request detail</h2>
          <div class="card__body">${emptyState({
            title: "Select a request",
            body: "Choose a request from the list to see its context and decide it. On a phone, open a request to see it on its own.",
          })}</div>
        </section>`
      : requestDetailPanel(detail, input);

  const splitClass = detail === null ? "split" : "split split--detail";

  const screenReaderLive = html`<p class="visually-hidden" aria-live="polite" data-request-summary>${requests.length} ${requests.length === 1 ? "request" : "requests"} shown.</p>`;

  return layout({
    ctx,
    title: "Requests",
    subtitle: history ? "Every decision, newest first." : "Pending requests, newest first.",
    content: html`${tabs(
      [
        { label: "Inbox", href: "/requests", current: !history, count: input.counts.inbox },
        {
          label: "History",
          href: "/requests?view=history",
          current: history,
          count: input.counts.history,
        },
      ],
      "Request views",
    )}
    ${screenReaderLive}
    <div class="${splitClass}">
      ${listCard}
      ${detailPanel}
    </div>`,
    pageClass: detail === null ? "page--requests" : "page--requests page--request-detail",
  });
}
