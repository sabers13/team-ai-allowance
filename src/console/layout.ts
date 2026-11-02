/**
 * The page shell: top bar, side navigation, phone bottom navigation, page
 * header, flash messages and the toast host.
 *
 * The shell renders the theme from the cookie on the server, so a page is in the
 * right theme before any script runs. The theme control is a plain form and the
 * "More" sheet is a `<details>` element, so both work without JavaScript.
 */

import { banner } from "./components.ts";
import type { ListMode, Theme, Viewer } from "./data.ts";
import { initials } from "./format.ts";
import { classes, type Html, html, raw } from "./html.ts";
import {
  iconChart,
  iconChevron,
  iconMoon,
  iconRules,
  iconSearch,
  iconSetup,
  iconSun,
  iconUsers,
} from "./icons.ts";

export interface FlashMessage {
  kind: "success" | "error" | "info" | "warning";
  message: string;
  title?: string;
}

export interface PageContext {
  viewer: Viewer;
  theme: Theme;
  path: string;
  now: Date;
  timeZone: string;
  flash: FlashMessage | null;
  mode: ListMode;
  openRequests: number;
}

export interface NavItem {
  label: string;
  href: string;
  icon: Html;
  /** The path prefix that marks this item as current. */
  match: string;
  count?: number;
}

function navItems(ctx: PageContext): NavItem[] {
  if (ctx.viewer.role === "member") {
    return [{ label: "My allowance", href: "/me", icon: iconChart(), match: "/me" }];
  }
  return [
    { label: "Overview", href: "/", icon: iconChart(), match: "/" },
    {
      label: "Requests",
      href: "/requests",
      icon: iconUsers(),
      match: "/requests",
      count: ctx.openRequests,
    },
    { label: "Usage", href: "/usage", icon: iconChart(), match: "/usage" },
    { label: "Members", href: "/#members", icon: iconUsers(), match: "/members" },
    { label: "Models", href: "/models", icon: iconChart(), match: "/models" },
    { label: "Rules", href: "/rules", icon: iconRules(), match: "/rules" },
    { label: "Audit", href: "/audit", icon: iconRules(), match: "/audit" },
    { label: "Setup", href: "/setup", icon: iconSetup(), match: "/setup" },
  ];
}

function isCurrent(ctx: PageContext, item: NavItem): boolean {
  if (item.href === "/") return ctx.path === "/";
  if (item.href === "/#members") return ctx.path.startsWith("/members");
  return ctx.path === item.match || ctx.path.startsWith(`${item.match}/`);
}

function countBadge(count: number | undefined, label: string): Html {
  if (count === undefined || count === 0) return html``;
  return html`<span class="count" data-open-count>${count}</span>
    <span class="visually-hidden">${label}</span>`;
}

function themeControl(ctx: PageContext): Html {
  const label = ctx.theme === "system" ? "System" : ctx.theme === "dark" ? "Dark" : "Light";
  const icon = ctx.theme === "dark" ? iconMoon() : iconSun();
  return html`<details class="menu menu--theme">
    <summary class="topbar__control" aria-label="Theme: ${label}">
      ${icon}<span class="topbar__control-label">${label}</span>${iconChevron()}
    </summary>
    <div class="menu__panel">
      <form method="post" action="/theme" data-theme-form>
        <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
        <input type="hidden" name="returnTo" value="${ctx.path}">
        <p class="menu__title">Theme</p>
        <button class="menu__item" type="submit" name="theme" value="system"${raw(ctx.theme === "system" ? ' aria-current="true"' : "")}>System</button>
        <button class="menu__item" type="submit" name="theme" value="light"${raw(ctx.theme === "light" ? ' aria-current="true"' : "")}>Light</button>
        <button class="menu__item" type="submit" name="theme" value="dark"${raw(ctx.theme === "dark" ? ' aria-current="true"' : "")}>Dark</button>
      </form>
    </div>
  </details>`;
}

function userControl(ctx: PageContext): Html {
  const allowance =
    ctx.viewer.memberId === null ? "" : html`<a class="menu__item" href="/me">My allowance</a>`;
  return html`<details class="menu menu--user">
    <summary class="topbar__user">
      <span class="visually-hidden">Account</span>
      <span class="avatar avatar--sm" aria-hidden="true">${initials(ctx.viewer.displayName)}</span>
      <span class="topbar__control-label">${ctx.viewer.displayName}</span>
    </summary>
    <div class="menu__panel">
      <p class="menu__title">${ctx.viewer.displayName}</p>
      <p class="menu__meta">${ctx.viewer.role} · ${ctx.viewer.teamName}</p>
      ${allowance}
      <form method="post" action="/logout" data-logout-form>
        <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
        <button class="menu__item" type="submit">Log out</button>
      </form>
    </div>
  </details>`;
}

function searchControl(ctx: PageContext): Html {
  if (ctx.viewer.role === "member") return html``;
  return html`<form class="search" role="search" action="/requests" method="get">
    <label class="visually-hidden" for="global-search">Search requests</label>
    <span class="search__icon" aria-hidden="true">${iconSearch()}</span>
    <input class="search__input" id="global-search" type="search" name="q" placeholder="Search requests" autocomplete="off">
  </form>`;
}

function topbar(ctx: PageContext, pageTitle: string): Html {
  const home = ctx.viewer.role === "member" ? "/me" : "/";
  return html`<header class="topbar">
    <div class="topbar__left">
      <a class="brand" href="${home}">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false"><path d="M2 3.5h10M2 7h7M2 10.5h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </span>
        <span class="brand__name">Allowance</span>
        <span class="visually-hidden">Allowance home</span>
      </a>
      <span class="topbar__divider" aria-hidden="true"></span>
      <span class="topbar__team">${ctx.viewer.teamName}</span>
    </div>
    <div class="topbar__mobile-title" aria-hidden="true">${pageTitle}</div>
    <div class="topbar__middle">${searchControl(ctx)}</div>
    <div class="topbar__actions">
      ${themeControl(ctx)}
      ${userControl(ctx)}
    </div>
  </header>`;
}

function sidenav(ctx: PageContext): Html {
  const items = navItems(ctx);
  const allowanceLink =
    ctx.viewer.role === "member"
      ? ""
      : html`<a class="quiet-link" href="/me"${raw(ctx.path === "/me" ? ' aria-current="page"' : "")}>My allowance</a>`;
  return html`<nav class="sidenav" aria-label="Sections">
    <ul class="sidenav__list">
      ${items.map(
        (item) => html`<li>
          <a class="${classes("sidenav__item", isCurrent(ctx, item) ? "sidenav__item--current" : "")}" href="${item.href}"${raw(isCurrent(ctx, item) ? ' aria-current="page"' : "")}>
            <span class="sidenav__icon" aria-hidden="true">${item.icon}</span>
            <span class="sidenav__label">${item.label}</span>
            ${countBadge(item.count, "open requests")}
          </a>
        </li>`,
      )}
    </ul>
    <div class="sidenav__footer">
      <p class="sidenav__hint">Times shown in ${ctx.timeZone}.</p>
      ${allowanceLink}
    </div>
  </nav>`;
}

function bottomnav(ctx: PageContext): Html {
  if (ctx.viewer.role === "member") {
    return html`<nav class="bottomnav" aria-label="Sections, phone">
      <a class="bottomnav__item bottomnav__item--current" href="/me" aria-current="page">
        ${iconChart()}<span>My allowance</span>
      </a>
    </nav>`;
  }
  const primary: NavItem[] = [
    { label: "Overview", href: "/", icon: iconChart(), match: "/" },
    {
      label: "Requests",
      href: "/requests",
      icon: iconUsers(),
      match: "/requests",
      count: ctx.openRequests,
    },
    { label: "Members", href: "/#members", icon: iconUsers(), match: "/members" },
    { label: "Models", href: "/models", icon: iconChart(), match: "/models" },
  ];
  const more = [
    { label: "Usage", href: "/usage", icon: iconChart(), match: "/usage" },
    { label: "Rules", href: "/rules", icon: iconRules(), match: "/rules" },
    { label: "Audit", href: "/audit", icon: iconRules(), match: "/audit" },
    { label: "Setup", href: "/setup", icon: iconSetup(), match: "/setup" },
  ];
  const moreCurrent = more.some((item) => isCurrent(ctx, item));
  return html`<nav class="bottomnav" aria-label="Sections, phone">
    ${primary.map(
      (
        item,
      ) => html`<a class="${classes("bottomnav__item", isCurrent(ctx, item) ? "bottomnav__item--current" : "")}" href="${item.href}"${raw(isCurrent(ctx, item) ? ' aria-current="page"' : "")}>
        <span class="bottomnav__icon" aria-hidden="true">${item.icon}</span>
        <span class="bottomnav__label">${item.label}</span>
        ${item.count === undefined || item.count === 0 ? "" : html`<span class="count count--dot" data-open-count>${item.count}</span>`}
      </a>`,
    )}
    <details class="bottomnav__more">
      <summary class="${classes("bottomnav__item", moreCurrent ? "bottomnav__item--current" : "")}"${raw(moreCurrent ? ' aria-current="page"' : "")}>
        <span class="bottomnav__icon" aria-hidden="true">${iconSetup()}</span>
        <span class="bottomnav__label">More</span>
      </summary>
      <div class="sheet">
        <p class="sheet__title">More</p>
        <ul class="sheet__list">
          ${more.map(
            (item) =>
              html`<li><a class="sheet__item" href="${item.href}">${item.icon}${item.label}</a></li>`,
          )}
        </ul>
      </div>
    </details>
  </nav>`;
}

export interface ShellOptions {
  ctx: PageContext;
  /** The document title and the visible page title. */
  title: string;
  subtitle?: string;
  actions?: Html;
  breadcrumb?: Html;
  content: Html;
  /** Extra class on the page container, for the request split view. */
  pageClass?: string;
}

export function layout(options: ShellOptions): Html {
  const { ctx } = options;
  const flash = ctx.flash === null ? html`` : banner(ctx.flash);
  const subtitle =
    options.subtitle === undefined ? "" : html`<p class="page__subtitle">${options.subtitle}</p>`;
  const actions =
    options.actions === undefined ? "" : html`<div class="page__actions">${options.actions}</div>`;
  return html`<!doctype html>
<html lang="en" data-theme="${ctx.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${options.title} · Allowance console</title>
  <link rel="stylesheet" href="/console.css">
  <script src="/console.js" defer></script>
</head>
<body class="page-body">
  <a class="skip-link" href="#main">Skip to content</a>
  ${topbar(ctx, options.title)}
  <div class="shell">
    ${sidenav(ctx)}
    <main id="main" class="main" tabindex="-1">
      <div class="${classes("page", options.pageClass)}">
        ${options.breadcrumb === undefined ? "" : html`<nav class="breadcrumb" aria-label="Breadcrumb">${options.breadcrumb}</nav>`}
        <header class="page__header">
          <div class="page__titles">
            <h1 class="page__title">${options.title}</h1>
            ${subtitle}
          </div>
          ${actions}
        </header>
        ${flash}
        ${options.content}
      </div>
      <footer class="page-footer">
        <p>team-ai-allowance · times in ${ctx.timeZone} · no prompt or response text is stored</p>
      </footer>
    </main>
  </div>
  ${bottomnav(ctx)}
  <p id="open-requests-live" class="visually-hidden" aria-live="polite"></p>
  <div id="toasts" class="toasts" role="status" aria-live="polite"></div>
</body>
</html>`;
}
