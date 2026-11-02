/**
 * The `/usage` page: period controls, a stacked daily chart, a sortable
 * per-member table and the CSV export.
 *
 * Managers see their own team; an admin sees every team (the adapter widens
 * the member list and says so in `scopeLabel`). A member never reaches this
 * page: the router sends a member session to `/me`.
 */

import {
  emptyState,
  field,
  listBlock,
  metric,
  sortHeader,
  statusPill,
  tableWrap,
  tabs,
} from "../components.ts";
import type { PageContext } from "../data.ts";
import { usd } from "../format.ts";
import { classes, type Html, html } from "../html.ts";
import { layout } from "../layout.ts";
import { stackedUsageChart } from "./chart.ts";
import { API_FORMAT_LABEL } from "./inference.ts";
import type { UsageMemberRow, UsageReport, UsageSeries } from "./report.ts";

export interface UsagePageInput {
  ctx: PageContext;
  report: UsageReport;
}

const STATUS_LABEL = {
  ok: "OK",
  soft: "Soft limit",
  grace: "Grace",
  blocked: "Blocked",
} as const;

function href(
  report: UsageReport,
  overrides: {
    period?: string;
    from?: string;
    to?: string;
    series?: UsageSeries;
    sort?: string;
    dir?: "asc" | "desc";
  } = {},
  path = "/usage",
): string {
  const params = new URLSearchParams();
  const key = overrides.period ?? report.period.key;
  if (key === "custom") {
    params.set("from", overrides.from ?? report.period.fromDate);
    params.set("to", overrides.to ?? report.period.toDate);
  } else {
    params.set("period", key);
  }
  params.set("series", overrides.series ?? report.series);
  params.set("sort", overrides.sort ?? report.sort.key);
  params.set("dir", overrides.dir ?? report.sort.direction);
  return `${path}?${params.toString()}`;
}

function periodTabs(report: UsageReport): Html {
  const items = [
    { key: "today", label: "Today" },
    { key: "7", label: "7 days" },
    { key: "30", label: "30 days" },
  ].map((entry) => ({
    label: entry.label,
    href: href(report, { period: entry.key }),
    current: report.period.key === entry.key,
  }));
  items.push({
    label: "Custom",
    href: "#custom-period",
    current: report.period.key === "custom",
  });
  return tabs(items, "Period");
}

function seriesTabs(report: UsageReport): Html {
  return tabs(
    [
      {
        label: "By member",
        href: href(report, { series: "member" }),
        current: report.series === "member",
      },
      {
        label: "By model",
        href: href(report, { series: "model" }),
        current: report.series === "model",
      },
    ],
    "Stack chart by",
  );
}

function customPeriodForm(report: UsageReport): Html {
  return html`<form class="usage-custom" id="custom-period" method="get" action="/usage">
    <input type="hidden" name="series" value="${report.series}">
    <input type="hidden" name="sort" value="${report.sort.key}">
    <input type="hidden" name="dir" value="${report.sort.direction}">
    ${field({
      id: "usage-from",
      label: "From",
      control: html`<input id="usage-from" name="from" type="date" required value="${report.period.fromDate}">`,
    })}
    ${field({
      id: "usage-to",
      label: "To",
      control: html`<input id="usage-to" name="to" type="date" required value="${report.period.toDate}">`,
    })}
    <div class="usage-custom__action">
      <button class="button" type="submit">Apply dates</button>
    </div>
  </form>`;
}

function summary(report: UsageReport): Html {
  return html`<div class="usage-summary card col-12">
    ${metric({
      label: "Requests",
      value: String(report.totalRequests),
      sub: report.period.label,
    })}
    ${metric({
      label: "Input tokens",
      value: report.totalInputTokens.toLocaleString("en-US"),
      sub: "all members in scope",
    })}
    ${metric({
      label: "Output tokens",
      value: report.totalOutputTokens.toLocaleString("en-US"),
      sub: "all members in scope",
    })}
    ${metric({
      label: "Cost",
      value: usd(report.totalCostUsd),
      sub: report.period.label,
      tone: "accent",
    })}
  </div>`;
}

function sortHref(report: UsageReport, key: string): string {
  const active = report.sort.key === key;
  const direction = active && report.sort.direction === "asc" ? "desc" : "asc";
  return href(report, { sort: key, dir: direction });
}

function memberRows(report: UsageReport): Html {
  const rows = report.rows.map((row) => memberRow(row));
  const header = html`<tr>
    ${sortHeader({ label: "Member", column: "name", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "name") })}
    ${sortHeader({ label: "Status", column: "status", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "status") })}
    ${sortHeader({ label: "Requests", column: "requests", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "requests"), numeric: true })}
    ${sortHeader({ label: "Input", column: "input", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "input"), numeric: true })}
    ${sortHeader({ label: "Output", column: "output", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "output"), numeric: true })}
    ${sortHeader({ label: "Cost", column: "cost", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "cost"), numeric: true })}
    ${sortHeader({ label: "% of limit", column: "percent", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "percent"), numeric: true })}
    ${sortHeader({ label: "Top model", column: "topModel", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "topModel") })}
    ${sortHeader({ label: "CLI (inferred)", column: "cli", sortKey: report.sort.key, direction: report.sort.direction, href: sortHref(report, "cli") })}
  </tr>`;
  return tableWrap(
    "Usage by member",
    html`<table class="table table--cards usage-table">
      <caption>Requests, tokens, cost and limit per member in ${report.period.label}. CLI is inferred from the API format.</caption>
      <thead>${header}</thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

function memberRow(row: UsageMemberRow): Html {
  const title = `${row.percentOfLimit}% of ${usd(row.limitUsd)}`;
  const status = statusPill({
    tone: row.status,
    label: STATUS_LABEL[row.status],
    title,
    description: `${STATUS_LABEL[row.status]}, ${title}`,
  });
  const cli = row.cli.cli;
  return html`<tr class="${classes(row.status === "blocked" ? "is-blocked" : "")}">
    <th scope="row"><a class="member-name__text" href="/members/${encodeURIComponent(row.memberId)}">${row.displayName}</a></th>
    <td data-label="Status">${status}</td>
    <td class="numeric" data-label="Requests">${row.requests}</td>
    <td class="numeric" data-label="Input">${row.inputTokens.toLocaleString("en-US")}</td>
    <td class="numeric" data-label="Output">${row.outputTokens.toLocaleString("en-US")}</td>
    <td class="numeric" data-label="Cost">${usd(row.costUsd)}</td>
    <td class="numeric" data-label="% of limit" title="${title}">${row.limitUsd <= 0 ? "—" : `${row.percentOfLimit}%`}</td>
    <td data-label="Top model">${
      row.topModelId === null
        ? "—"
        : html`<span>${row.topModel}</span><span class="usage-table__sub mono">${row.topModelId}</span>`
    }</td>
    <td data-label="CLI (inferred)">
      <span>${cli.label}</span>
      <span class="usage-table__sub">${row.cli.mixed ? "mixed formats · " : ""}${API_FORMAT_LABEL[cli.apiFormat]} · inferred</span>
    </td>
  </tr>`;
}

export function renderUsage(input: UsagePageInput): Html {
  const { ctx, report } = input;
  const csvHref = href(report, {}, "/usage.csv");
  const actions = html`<a class="button" href="${csvHref}">Download CSV</a>`;
  const hasUsage = report.totalRequests > 0;

  const chart = listBlock({
    mode: ctx.mode,
    isEmpty: !hasUsage || report.seriesRows.length === 0,
    ready: stackedUsageChart(report, ctx.timeZone),
    empty: emptyState({
      title: "No usage in this period",
      body: "Calls recorded by the gateway appear here, grouped by member or by model.",
    }),
    retryHref: href(report),
    loadingLabel: "Loading the daily chart…",
  });

  const table = listBlock({
    mode: ctx.mode,
    isEmpty: report.rows.length === 0,
    ready: memberRows(report),
    empty: emptyState({
      title: "No members in scope",
      body: "Enrol a member, or widen the period, and the table fills in.",
      actionHref: "/setup",
      actionLabel: "Open setup",
    }),
    retryHref: href(report),
    loadingLabel: "Loading usage…",
  });

  return layout({
    ctx,
    title: "Usage",
    subtitle: `${report.period.label} · ${report.scopeLabel}`,
    actions,
    content: html`<div class="grid">
      <div class="col-12">${periodTabs(report)}</div>
      <div class="col-12">${customPeriodForm(report)}</div>
      ${summary(report)}
      <section class="card col-12" aria-labelledby="usage-chart-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="usage-chart-title">Daily cost</h2>
            <p class="card__subtitle">Stacked by ${report.series}. Every series is labelled in the legend and in the table below the chart.</p>
          </div>
          <div class="card__actions">${seriesTabs(report)}</div>
        </header>
        <div class="card__body">${chart}</div>
      </section>
      <section class="card col-12" aria-labelledby="usage-table-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="usage-table-title">By member</h2>
            <p class="card__subtitle">Sort any column with the header link. The CSV carries these rows in the same order.</p>
          </div>
        </header>
        <div class="card__body">${table}</div>
        <p class="xs muted" style="margin-top: 12px">
          <strong>CLI is inferred, not observed.</strong> Anthropic Messages means Claude Code, the Responses API means OpenCode and Chat Completions means Codex. Rows without a recorded API format show Unknown.
        </p>
      </section>
    </div>`,
  });
}
