/**
 * Shared server-rendered HTML components for the manager console.
 *
 * Components return `Html`; pages compose them. Nothing here knows about a
 * route, so every component can be reused by member, manager and setup pages.
 */

import type { ListMode } from "./data.ts";
import { classes, type Html, html, join, raw } from "./html.ts";
import { iconAlert, iconBlocked, iconChart, iconCheck, iconInbox } from "./icons.ts";
import type { StatusView } from "./status.ts";

export function statusPill(view: StatusView): Html {
  return html`<span class="${classes("pill", `pill--${view.tone}`)}" title="${view.title}">
    <span class="pill__dot" aria-hidden="true"></span>${view.label}
  </span>`;
}

export interface CardOptions {
  title: string;
  subtitle?: string;
  actions?: Html;
  body: Html;
  className?: string;
  id?: string;
  /** Heading level for the card title; defaults to h2. */
  headingLevel?: 2 | 3;
}

export function card(options: CardOptions): Html {
  const level = options.headingLevel ?? 2;
  const heading = level === 2 ? "h2" : "h3";
  const subtitle =
    options.subtitle === undefined ? "" : html`<p class="card__subtitle">${options.subtitle}</p>`;
  return html`<section class="${classes("card", options.className)}"${options.id === undefined ? "" : raw(` id="${options.id}"`)}>
    <header class="card__header">
      <div class="card__titles">
        <${raw(heading)} class="card__title">${options.title}</${raw(heading)}>
        ${subtitle}
      </div>
      ${options.actions === undefined ? "" : html`<div class="card__actions">${options.actions}</div>`}
    </header>
    <div class="card__body">${options.body}</div>
  </section>`;
}

export interface MetricOptions {
  label: string;
  value: string;
  sub?: string;
  tone?: "accent" | "ok" | "soft" | "grace" | "blocked" | "neutral";
}

export function metric(options: MetricOptions): Html {
  return html`<div class="${classes("metric", options.tone === undefined ? "" : `metric--${options.tone}`)}">
    <p class="metric__label">${options.label}</p>
    <p class="metric__value">${options.value}</p>
    ${options.sub === undefined ? "" : html`<p class="metric__sub">${options.sub}</p>`}
  </div>`;
}

export interface EmptyStateOptions {
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}

export function emptyState(options: EmptyStateOptions): Html {
  return html`<div class="state state--empty">
    <span class="state__icon">${iconInbox()}</span>
    <p class="state__title">${options.title}</p>
    <p class="state__body">${options.body}</p>
    ${
      options.actionHref === undefined || options.actionLabel === undefined
        ? ""
        : html`<a class="button button--secondary" href="${options.actionHref}">${options.actionLabel}</a>`
    }
  </div>`;
}

export function loadingState(label = "Loading…"): Html {
  return html`<div class="state state--loading" role="status" aria-busy="true">
    <p class="state__title">${label}</p>
    <p class="state__body">The list will appear as soon as it arrives.</p>
  </div>`;
}

export interface ErrorStateOptions {
  message: string;
  retryHref: string;
}

export function errorState(options: ErrorStateOptions): Html {
  return html`<div class="state state--error" role="alert">
    <span class="state__icon state__icon--error">${iconAlert()}</span>
    <p class="state__title">This list could not be loaded</p>
    <p class="state__body">${options.message}</p>
    <a class="button button--secondary" href="${options.retryHref}">Try again</a>
  </div>`;
}

export interface BannerOptions {
  kind: "success" | "error" | "info" | "warning";
  message: string;
  title?: string;
}

export function banner(options: BannerOptions): Html {
  const role = options.kind === "error" || options.kind === "warning" ? "alert" : "status";
  const icon =
    options.kind === "success"
      ? iconCheck()
      : options.kind === "error" || options.kind === "warning"
        ? iconAlert()
        : iconBlocked();
  return html`<div class="${classes("banner", `banner--${options.kind}`)}" role="${role}">
    <span class="banner__icon">${icon}</span>
    <div class="banner__text">
      ${options.title === undefined ? "" : html`<p class="banner__title">${options.title}</p>`}
      <p class="banner__message">${options.message}</p>
    </div>
  </div>`;
}

export interface FieldOptions {
  id: string;
  label: string;
  control: Html;
  hint?: string;
  error?: string;
  optional?: boolean;
}

export function field(options: FieldOptions): Html {
  const label =
    options.optional === true
      ? html`<span class="field__label">${options.label} <span class="field__optional">(optional)</span></span>`
      : html`<span class="field__label">${options.label}</span>`;
  return html`<div class="${classes("field", options.error === undefined ? "" : "field--error")}">
    <label class="field__label-row" for="${options.id}">${label}</label>
    ${options.hint === undefined ? "" : html`<p class="field__hint" id="${options.id}-hint">${options.hint}</p>`}
    ${options.error === undefined ? "" : html`<p class="field__error" id="${options.id}-error">${options.error}</p>`}
    ${options.control}
  </div>`;
}

export function fieldset(legend: string, body: Html, hint?: string): Html {
  return html`<fieldset class="fieldset">
    <legend class="field__label">${legend}</legend>
    ${hint === undefined ? "" : html`<p class="field__hint">${hint}</p>`}
    ${body}
  </fieldset>`;
}

export function formError(message: string | null): Html {
  if (message === null || message === "") return html``;
  return html`<p class="form-error" role="alert">${message}</p>`;
}

export function tableWrap(label: string, table: Html, className = ""): Html {
  return html`<div class="${classes("table-wrap", className)}" role="region" aria-label="${label}" tabindex="0">
    ${table}
  </div>`;
}

export function sortHeader(options: {
  label: string;
  column: string;
  sortKey: string;
  direction: "asc" | "desc";
  href: string;
  numeric?: boolean;
}): Html {
  const active = options.sortKey === options.column;
  const nextDirection = active && options.direction === "asc" ? "desc" : "asc";
  const ariaSort = active ? (options.direction === "asc" ? "ascending" : "descending") : "none";
  const arrow = active ? (options.direction === "asc" ? "↑" : "↓") : "";
  return html`<th scope="col" aria-sort="${ariaSort}" class="${options.numeric === true ? "numeric" : ""}">
    <a class="sort" href="${options.href}" data-sort="${options.column}" data-direction="${nextDirection}">
      ${options.label}<span class="sort__arrow" aria-hidden="true">${arrow}</span>
      <span class="visually-hidden">${ariaSort === "none" ? "Sort by" : `Sorted ${ariaSort}; sort by`} ${options.label}</span>
    </a>
  </th>`;
}

export interface TabItem {
  label: string;
  href: string;
  current: boolean;
  count?: number;
}

export function tabs(items: TabItem[], label = "Views"): Html {
  return html`<nav class="tabs" aria-label="${label}">
    ${items.map(
      (
        item,
      ) => html`<a class="${classes("tabs__item", item.current ? "tabs__item--current" : "")}" href="${item.href}"${item.current ? raw(' aria-current="page"') : ""}>
        ${item.label}${item.count === undefined ? "" : html` <span class="count">${item.count}</span>`}
      </a>`,
    )}
  </nav>`;
}

export function progressBar(value: number, max: number, label: string): Html {
  const share = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return html`<div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}">
    <span class="progress__fill" style="width: ${share}%"></span>
  </div>`;
}

export interface ListBlockOptions {
  mode: ListMode;
  isEmpty: boolean;
  ready: Html;
  empty: Html;
  retryHref: string;
  loadingLabel?: string;
  errorMessage?: string;
}

export function listBlock(options: ListBlockOptions): Html {
  if (options.mode === "loading") return loadingState(options.loadingLabel ?? "Loading…");
  if (options.mode === "empty") return options.empty;
  if (options.mode === "error") {
    return errorState({
      message: options.errorMessage ?? "The control service did not answer. Nothing was changed.",
      retryHref: options.retryHref,
    });
  }
  return options.isEmpty ? options.empty : options.ready;
}

export function definitionList(
  rows: Array<{ label: string; value: Html | string; numeric?: boolean }>,
): Html {
  return html`<dl class="defs">
    ${rows.map(
      (row) => html`<div class="defs__row">
        <dt class="defs__label">${row.label}</dt>
        <dd class="${classes("defs__value", row.numeric === true ? "numeric" : "")}">${row.value}</dd>
      </div>`,
    )}
  </dl>`;
}

export function inlineSpinner(): Html {
  return html`<span class="spinner" aria-hidden="true"></span>`;
}

export function chartIcon(): Html {
  return iconChart();
}

export function joinHtml(values: Html[]): Html {
  return join(values);
}
