import type { Notification } from "../../contracts.ts";
import {
  emptyState,
  listBlock,
  metric,
  progressBar,
  sortHeader,
  statusPill,
  tableWrap,
} from "../components.ts";
import type { OverviewData, PageContext, PageSort } from "../data.ts";
import { dateOnly, initials, percent, percentText, relative, usd } from "../format.ts";
import { type Html, html, raw } from "../html.ts";
import { iconAlert, iconBlocked, iconCheck, iconInbox } from "../icons.ts";
import { notificationLabel, periodLabel, requestKindLabel, requestSubject } from "../labels.ts";
import { layout } from "../layout.ts";
import { statusView } from "../status.ts";

function notificationIcon(kind: Notification["kind"]): Html {
  switch (kind) {
    case "request_created":
      return iconInbox();
    case "request_decided":
      return iconCheck();
    case "member_blocked":
    case "hard_limit":
    case "off_hours_block":
      return iconBlocked();
    default:
      return iconAlert();
  }
}

function membersTable(data: OverviewData, sort: PageSort, ctx: PageContext): Html {
  const rows = data.members.map((row) => {
    const status = statusView(row.policy, row.spendUsd);
    const blockedClass = status.tone === "blocked" ? ' class="is-blocked"' : "";
    return html`<tr${raw(blockedClass)}>
      <td data-label="Member">
        <span class="member-name">
          <span class="avatar" aria-hidden="true">${initials(row.member.displayName)}</span>
          <a class="member-name__text" href="/members/${row.member.id}">${row.member.displayName}</a>
        </span>
      </td>
      <td class="numeric" data-label="Spend">${usd(row.spendUsd)}</td>
      <td class="numeric" data-label="Limit">${usd(row.policy.effectiveBudgetUsd)}<span class="visually-hidden"> ${periodLabel(row.policy.limits.period)}</span></td>
      <td class="numeric" data-label="Used">${percentText(row.spendUsd, row.policy.effectiveBudgetUsd)}</td>
      <td data-label="Status">${statusPill(status)}</td>
    </tr>`;
  });

  const header = html`<tr>
    ${sortHeader({ label: "Member", column: "name", sortKey: sort.key, direction: sort.direction, href: `/?sort=name&dir=${sort.key === "name" && sort.direction === "asc" ? "desc" : "asc"}` })}
    ${sortHeader({ label: "Spend", column: "spend", sortKey: sort.key, direction: sort.direction, href: `/?sort=spend&dir=${sort.key === "spend" && sort.direction === "desc" ? "asc" : "desc"}`, numeric: true })}
    <th scope="col" class="numeric">Limit</th>
    ${sortHeader({ label: "Used", column: "used", sortKey: sort.key, direction: sort.direction, href: `/?sort=used&dir=${sort.key === "used" && sort.direction === "desc" ? "asc" : "desc"}`, numeric: true })}
    ${sortHeader({ label: "Status", column: "status", sortKey: sort.key, direction: sort.direction, href: `/?sort=status&dir=${sort.key === "status" && sort.direction === "asc" ? "desc" : "asc"}` })}
  </tr>`;

  const table = html`<table class="table table--cards">
    <caption>Members of ${data.team.name}, spend in each member's own budget period.</caption>
    <thead>${header}</thead>
    <tbody>${rows}</tbody>
  </table>`;

  return listBlock({
    mode: ctx.mode,
    isEmpty: data.members.length === 0,
    ready: tableWrap("Members", table),
    empty: emptyState({
      title: "No members yet",
      body: "Members appear here once they are enrolled from the setup page.",
      actionHref: "/setup",
      actionLabel: "Open setup",
    }),
    retryHref: "/",
    loadingLabel: "Loading members…",
  });
}

export function renderOverview(input: {
  ctx: PageContext;
  data: OverviewData;
  sort: PageSort;
}): Html {
  const { ctx, data, sort } = input;
  const budget = data.team.monthlyBudgetUsd;
  const blocked = data.members.filter((row) => row.policy.status === "blocked").length;
  const soft = data.members.filter((row) => row.policy.status === "soft").length;
  const spendShare = percent(data.teamSpendUsd, budget);

  const atAGlance = html`<div class="stack stack--tight">
    ${metric({
      label: "Open requests",
      value: String(data.openRequests.length),
      sub: data.openRequests.length === 0 ? "Nothing is waiting" : "Waiting for a decision",
      tone: data.openRequests.length > 0 ? "soft" : "ok",
    })}
    <dl class="defs">
      <div class="defs__row"><dt class="defs__label">Members at soft limit</dt><dd class="defs__value numeric">${soft}</dd></div>
      <div class="defs__row"><dt class="defs__label">Members blocked</dt><dd class="defs__value numeric">${blocked}</dd></div>
      <div class="defs__row"><dt class="defs__label">Models in catalogue</dt><dd class="defs__value numeric">${data.models.length}</dd></div>
    </dl>
  </div>`;

  const openRequestItems = data.openRequests.map(
    (request) => html`<li class="alerts__item">
      <span class="member-name__text">
        <a href="/requests/${request.id}">${requestSubject(request)}</a>
        <span class="muted small"> · ${requestKindLabel(request.kind)}</span>
      </span>
      <span class="faint xs nowrap" title="${request.createdAt}">${relative(request.createdAt, ctx.now)}</span>
    </li>`,
  );

  const alerts = data.alerts.map(
    (alert) => html`<li class="alerts__item">
      <span aria-hidden="true">${notificationIcon(alert.kind)}</span>
      <span>
        <strong class="small">${notificationLabel(alert.kind)}</strong>
        <span class="muted small"> ${alert.title}</span>
        <span class="faint xs"> · ${relative(alert.at, ctx.now)}</span>
      </span>
    </li>`,
  );

  const modelTotal = data.spendByModel.reduce((sum, row) => sum + row.spendUsd, 0);
  const modelRows = data.spendByModel.map(
    (row) => html`<tr>
      <td data-label="Model"><span class="mono small">${row.modelId}</span><div class="muted xs">${row.modelName}</div></td>
      <td class="numeric" data-label="Requests">${row.requests}</td>
      <td class="numeric" data-label="Spend">${usd(row.spendUsd)}</td>
      <td data-label="Share">
        <div class="row" style="gap: 8px; flex-wrap: nowrap">
          ${progressBar(row.spendUsd, Math.max(modelTotal, 0.01), `${row.modelId} share of spend`)}
          <span class="xs muted numeric nowrap">${percentText(row.spendUsd, Math.max(modelTotal, 0.01))}</span>
        </div>
      </td>
    </tr>`,
  );

  const content = html`<div class="grid">
    <section class="card card--primary col-8" aria-labelledby="team-spend-title">
      <h2 class="card__title" id="team-spend-title">Team spend this month</h2>
      <p class="metric__value" style="margin-top: 8px">${usd(data.teamSpendUsd)}</p>
      <p class="metric__sub">of ${usd(budget)} · ${data.periodLabel} · resets ${dateOnly(data.periodEndsAt, ctx.timeZone)}</p>
      ${progressBar(data.teamSpendUsd, budget, "Team spend against the monthly budget")}
      <p class="xs muted" style="margin-top: 8px">${spendShare}% of the monthly budget used. Gateway limits are exact per request; the console is near-real-time, within one poll interval.</p>
    </section>

    <section class="card col-4" aria-labelledby="at-a-glance-title">
      <h2 class="card__title" id="at-a-glance-title">At a glance</h2>
      <div class="card__body" style="margin-top: 12px">${atAGlance}</div>
    </section>

    <section class="card col-12" id="members" aria-labelledby="members-title">
      <header class="card__header">
        <div class="card__titles">
          <h2 class="card__title" id="members-title">Members</h2>
          <p class="card__subtitle">Spend, limit and status for each member.</p>
        </div>
        <div class="card__actions"><a class="button button--secondary button--sm" href="/setup">Add a member</a></div>
      </header>
      <div class="card__body">${membersTable(data, sort, ctx)}</div>
    </section>

    <section class="card col-7" aria-labelledby="overview-requests-title">
      <header class="card__header">
        <div class="card__titles">
          <h2 class="card__title" id="overview-requests-title">Open requests</h2>
          <p class="card__subtitle">Pending for more than a day are shown first.</p>
        </div>
        <div class="card__actions"><a class="button button--secondary button--sm" href="/requests">Open inbox</a></div>
      </header>
      <div class="card__body">${listBlock({
        mode: ctx.mode,
        isEmpty: data.openRequests.length === 0,
        ready: html`<ul class="alerts" aria-label="Open requests">${openRequestItems}</ul>`,
        empty: emptyState({
          title: "No open requests",
          body: "A member can ask for more budget or a model from the CLI, and new requests appear here.",
        }),
        retryHref: "/",
        loadingLabel: "Loading requests…",
      })}</div>
    </section>

    <section class="card col-5" aria-labelledby="overview-alerts-title">
      <h2 class="card__title" id="overview-alerts-title">Recent alerts</h2>
      <p class="card__subtitle">Threshold and cap notices from the watcher.</p>
      <div class="card__body" style="margin-top: 8px">${listBlock({
        mode: ctx.mode,
        isEmpty: data.alerts.length === 0,
        ready: html`<ul class="alerts" aria-label="Recent alerts">${alerts}</ul>`,
        empty: emptyState({
          title: "No alerts",
          body: "Soft limits, grace, hard stops and unusual spend appear here when they happen.",
        }),
        retryHref: "/",
        loadingLabel: "Loading alerts…",
      })}</div>
    </section>

    <section class="card col-12" aria-labelledby="spend-by-model-title">
      <h2 class="card__title" id="spend-by-model-title">Spend by model</h2>
      <p class="card__subtitle">The last 30 days, across every member.</p>
      <div class="card__body" style="margin-top: 12px">${listBlock({
        mode: ctx.mode,
        isEmpty: data.spendByModel.length === 0,
        ready: tableWrap(
          "Spend by model",
          html`<table class="table">
            <caption>Spend and request count per model over the last 30 days.</caption>
            <thead><tr><th scope="col">Model</th><th scope="col" class="numeric">Requests</th><th scope="col" class="numeric">Spend</th><th scope="col">Share</th></tr></thead>
            <tbody>${modelRows}</tbody>
          </table>`,
        ),
        empty: emptyState({
          title: "No spend recorded yet",
          body: "Usage appears here after the first gateway poll.",
        }),
        retryHref: "/",
        loadingLabel: "Loading spend…",
      })}</div>
    </section>
  </div>`;

  const actions =
    data.openRequests.length > 0
      ? html`<a class="button button--primary" href="/requests">Review ${data.openRequests.length} ${data.openRequests.length === 1 ? "request" : "requests"}</a>`
      : html`<a class="button button--secondary" href="/models">View models</a>`;

  return layout({
    ctx,
    title: "Overview",
    subtitle: `${data.team.name} · ${data.periodLabel}`,
    actions,
    content,
  });
}
