/**
 * The console stylesheet, served at `/console.css`.
 *
 * Design tokens and component styles for the server-rendered console.
 * Light is the default; dark applies from the system setting unless the theme
 * cookie pins light, and always when the cookie pins dark.
 */

export const CONSOLE_CSS = `/* team-ai-allowance console styles */
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --surface-3: #e6eaf0;
  --border: #d8dde5;
  --border-strong: #b6bfcc;
  --text: #151a21;
  --text-muted: #56606e;
  --text-faint: #6b7482;
  --accent: #2f5fd0;
  --accent-hover: #244ea8;
  --accent-soft: #e8eefc;
  --focus: #2f5fd0;
  --on-accent: #ffffff;
  --ok-text: #155c33;
  --ok-bg: #e5f4ea;
  --soft-text: #8a5a00;
  --soft-bg: #fff6e0;
  --grace-text: #9a4a00;
  --grace-bg: #ffefd9;
  --blocked-text: #a32424;
  --blocked-bg: #fdeaea;
  --shadow: 0 1px 2px rgb(16 24 40 / 0.04);
  --shadow-pop: 0 4px 8px rgb(16 24 40 / 0.12);
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-pill: 999px;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-md: 16px;
  --text-lg: 20px;
  --text-xl: 24px;
  --text-2xl: 32px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f1216;
    --surface: #161b22;
    --surface-2: #1d242d;
    --surface-3: #27303b;
    --border: #2c343f;
    --border-strong: #465260;
    --text: #e8ecf1;
    --text-muted: #a2acb9;
    --text-faint: #8b95a3;
    --accent: #7da2ff;
    --accent-hover: #9ab7ff;
    --accent-soft: #1b2a4a;
    --focus: #9ab7ff;
    --on-accent: #0f1216;
    --ok-text: #7fd6a0;
    --ok-bg: #12261a;
    --soft-text: #f2c46b;
    --soft-bg: #2a2110;
    --grace-text: #f0a35e;
    --grace-bg: #2b1a0d;
    --blocked-text: #ff8f8f;
    --blocked-bg: #2c1414;
    --shadow: none;
    --shadow-pop: 0 4px 8px rgb(0 0 0 / 0.5);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1216;
  --surface: #161b22;
  --surface-2: #1d242d;
  --surface-3: #27303b;
  --border: #2c343f;
  --border-strong: #465260;
  --text: #e8ecf1;
  --text-muted: #a2acb9;
  --text-faint: #8b95a3;
  --accent: #7da2ff;
  --accent-hover: #9ab7ff;
  --accent-soft: #1b2a4a;
  --focus: #9ab7ff;
  --on-accent: #0f1216;
  --ok-text: #7fd6a0;
  --ok-bg: #12261a;
  --soft-text: #f2c46b;
  --soft-bg: #2a2110;
  --grace-text: #f0a35e;
  --grace-bg: #2b1a0d;
  --blocked-text: #ff8f8f;
  --blocked-bg: #2c1414;
  --shadow: none;
  --shadow-pop: 0 4px 8px rgb(0 0 0 / 0.5);
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 20px;
}
h1, h2, h3, p, ul, ol, dl, figure { margin: 0; }
ul, ol { padding: 0; }
img, svg { max-width: 100%; }
a { color: var(--accent); text-underline-offset: 2px; }
a:hover { color: var(--accent-hover); }
strong { font-weight: 600; }
code, pre, .mono { font-family: var(--font-mono); }
pre {
  margin: 0;
  padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  line-height: 16px;
  overflow-x: auto;
  max-width: 100%;
}
hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }

:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.visually-hidden {
  position: absolute !important;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
  contain: strict;
}

.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  transform: translateY(-200%);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: var(--text-sm);
  text-decoration: none;
}
.skip-link:focus { transform: none; }

/* Top bar */
.topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.topbar__left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text); }
.brand__mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
}
.brand__name { font-weight: 600; font-size: var(--text-md); }
.topbar__divider { width: 1px; height: 20px; background: var(--border); }
.topbar__team { color: var(--text-muted); font-size: var(--text-sm); white-space: nowrap; }
.topbar__middle { flex: 1; display: flex; justify-content: center; min-width: 0; }
.topbar__mobile-title { display: none; }
.topbar__actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.topbar__control, .topbar__user {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 32px; padding: 0 8px;
  border: 1px solid transparent; border-radius: var(--radius-md);
  background: transparent; color: var(--text-muted);
  font: inherit; font-size: var(--text-sm);
  cursor: pointer; list-style: none;
}
.topbar__control:hover, .topbar__user:hover { background: var(--surface-3); color: var(--text); }
.topbar__control::-webkit-details-marker, .topbar__user::-webkit-details-marker { display: none; }
.topbar__control-label { white-space: nowrap; }
.icon { width: 20px; height: 20px; flex: 0 0 auto; }

.search { position: relative; width: 100%; max-width: 360px; }
.search__input {
  width: 100%; height: 32px; padding: 0 12px 0 34px;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit; font-size: var(--text-sm);
}
.search__icon { position: absolute; left: 9px; top: 6px; color: var(--text-faint); pointer-events: none; }

.menu { position: relative; }
.menu__panel {
  position: absolute; right: 0; top: calc(100% + 6px);
  min-width: 220px; padding: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  z-index: 50;
}
.menu__title { padding: 4px 8px; font-size: var(--text-sm); font-weight: 600; }
.menu__meta { padding: 0 8px 8px; color: var(--text-muted); font-size: var(--text-xs); }
.menu__item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-height: 32px; padding: 0 8px;
  background: transparent; border: 0; border-radius: var(--radius-sm);
  color: var(--text); font: inherit; font-size: var(--text-sm);
  text-align: left; text-decoration: none; cursor: pointer;
}
.menu__item:hover { background: var(--surface-3); }
.menu__item[aria-current="true"] { background: var(--accent-soft); color: var(--accent); }

.avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; flex: 0 0 auto;
  border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
}
.avatar--sm { width: 22px; height: 22px; font-size: 10px; }

/* Shell and navigation */
.shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); align-items: start; }
.sidenav {
  position: sticky; top: 56px;
  height: calc(100vh - 56px);
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 16px 12px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.sidenav__list { list-style: none; display: flex; flex-direction: column; gap: 2px; }
.sidenav__item {
  display: flex; align-items: center; gap: 10px;
  min-height: 36px; padding: 0 10px;
  border-left: 3px solid transparent;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-muted); text-decoration: none; font-size: var(--text-base);
}
.sidenav__item:hover { background: var(--surface-3); color: var(--text); }
.sidenav__item--current {
  background: var(--accent-soft);
  border-left-color: var(--accent);
  color: var(--text); font-weight: 500;
}
.sidenav__icon { display: inline-flex; color: inherit; }
.sidenav__label { flex: 1; min-width: 0; }
.sidenav__footer { padding: 12px 10px 4px; border-top: 1px solid var(--border); }
.sidenav__hint { color: var(--text-faint); font-size: var(--text-xs); margin-bottom: 8px; }
.quiet-link { color: var(--text-muted); font-size: var(--text-sm); }

.bottomnav { display: none; }

.main { min-width: 0; padding: 24px 32px 64px; }
.main:focus { outline: none; }
.page { max-width: 1280px; margin: 0 auto; }
.page-footer { max-width: 1280px; margin: 32px auto 0; color: var(--text-muted); font-size: var(--text-xs); }

.breadcrumb { margin-bottom: 8px; font-size: var(--text-sm); color: var(--text-muted); }
.breadcrumb a { color: var(--text-muted); }

.page__header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 16px; margin-bottom: 20px;
}
.page__titles { min-width: 0; }
.page__title { font-size: var(--text-xl); line-height: 32px; font-weight: 600; }
.page__subtitle { margin-top: 4px; color: var(--text-muted); font-size: var(--text-base); }
.page__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* Grid */
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
.col-3 { grid-column: span 3; }
.col-4 { grid-column: span 4; }
.col-5 { grid-column: span 5; }
.col-6 { grid-column: span 6; }
.col-7 { grid-column: span 7; }
.col-8 { grid-column: span 8; }
.col-9 { grid-column: span 9; }
.col-12 { grid-column: span 12; }
.stack { display: flex; flex-direction: column; gap: 16px; }
.stack--tight { gap: 8px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row--between { justify-content: space-between; }
.row--end { justify-content: flex-end; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.small { font-size: var(--text-sm); }
.xs { font-size: var(--text-xs); }
.numeric { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.break { overflow-wrap: anywhere; }

/* Cards */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px;
  box-shadow: var(--shadow);
  min-width: 0;
}
.card--primary { padding: 24px; border-radius: var(--radius-lg); }
.card--flush { padding: 0; overflow: hidden; }
.card__header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; margin-bottom: 12px;
}
.card__titles { min-width: 0; }
.card__title { font-size: var(--text-md); line-height: 24px; font-weight: 500; }
.card__subtitle { margin-top: 2px; color: var(--text-muted); font-size: var(--text-sm); }
.card__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.card__body { min-width: 0; }

.metric__label { color: var(--text-muted); font-size: var(--text-xs); font-weight: 500; }
.metric__value {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-2xl);
  line-height: 40px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.metric__sub { margin-top: 4px; color: var(--text-muted); font-size: var(--text-sm); }
.metric--ok .metric__value { color: var(--ok-text); }
.metric--soft .metric__value { color: var(--soft-text); }
.metric--grace .metric__value { color: var(--grace-text); }
.metric--blocked .metric__value { color: var(--blocked-text); }

.progress { height: 8px; margin-top: 12px; background: var(--surface-3); border-radius: var(--radius-pill); overflow: hidden; }
.progress__fill { display: block; height: 100%; background: var(--accent); border-radius: inherit; }

/* Status pill */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-2); color: var(--text);
  font-size: var(--text-xs); line-height: 16px; font-weight: 500;
  white-space: nowrap;
}
.pill__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill--ok { background: var(--ok-bg); color: var(--ok-text); }
.pill--soft { background: var(--soft-bg); color: var(--soft-text); }
.pill--grace { background: var(--grace-bg); color: var(--grace-text); }
.pill--blocked { background: var(--blocked-bg); color: var(--blocked-text); }
.pill--accent { background: var(--accent-soft); color: var(--accent); }
.pill--neutral { background: var(--surface-2); color: var(--text-muted); }

.count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--accent);
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
}
.count--dot { position: absolute; top: 4px; right: calc(50% - 22px); min-width: 18px; height: 18px; }

/* Tables */
.table-wrap { max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); line-height: 18px; }
caption { padding: 0 12px 8px; color: var(--text-muted); font-size: var(--text-xs); text-align: left; }
th, td { padding: 11px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
thead th { background: var(--surface-2); color: var(--text-muted); font-size: var(--text-xs); font-weight: 500; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-3); }
tr.is-blocked > :first-child { box-shadow: inset 3px 0 0 var(--blocked-text); }
th.numeric, td.numeric { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
td.numeric, th.numeric { white-space: nowrap; }
.sort { display: inline-flex; align-items: center; gap: 4px; color: inherit; text-decoration: none; }
.sort:hover { color: var(--text); }
.sort__arrow { font-family: var(--font-mono); }
.table-empty { padding: 24px; color: var(--text-muted); font-size: var(--text-sm); text-align: center; }

/* Definition list */
.defs { display: flex; flex-direction: column; gap: 8px; }
.defs__row { display: flex; justify-content: space-between; gap: 16px; }
.defs__label { color: var(--text-muted); font-size: var(--text-sm); }
.defs__value { font-size: var(--text-sm); text-align: right; }

/* Forms */
input, select, textarea { font: inherit; color: var(--text); }
input[type="text"], input[type="email"], input[type="password"], input[type="search"],
input[type="number"], input[type="date"], select, textarea, .input {
  width: 100%;
  min-height: 36px;
  padding: 0 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
select { padding-right: 32px; }
textarea { min-height: 88px; padding: 8px 12px; line-height: 20px; resize: vertical; }
input[type="checkbox"], input[type="radio"] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; min-width: 0; }
.field__label-row { display: block; }
.field__label { font-size: var(--text-base); font-weight: 500; }
.field__optional { color: var(--text-faint); font-weight: 400; }
.field__hint { color: var(--text-muted); font-size: var(--text-sm); }
.field__error { color: var(--blocked-text); font-size: var(--text-sm); font-weight: 500; }
.field--error input, .field--error select, .field--error textarea { border-color: var(--blocked-text); }
.field-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.field-row .field { margin-bottom: 0; }
.fieldset { border: 0; padding: 0; margin: 0 0 12px; min-width: 0; }
.fieldset .field__label { display: block; margin-bottom: 6px; }
.check { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: var(--text-sm); }
.check input { margin-top: 1px; flex: 0 0 auto; }
.check__label { cursor: pointer; }
.form-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: var(--blocked-bg);
  color: var(--blocked-text);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: 500;
}
.form-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.form-actions--end { justify-content: flex-end; }

/* Buttons */
.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 32px; padding: 0 12px;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  font: inherit; font-size: var(--text-sm); font-weight: 500;
  text-decoration: none; cursor: pointer;
}
.button:hover { background: var(--surface-3); color: var(--text); }
.button--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.button--primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--on-accent); }
.button--danger { background: transparent; border-color: var(--blocked-text); color: var(--blocked-text); }
.button--danger:hover { background: var(--blocked-bg); color: var(--blocked-text); }
.button--quiet { background: transparent; border-color: transparent; color: var(--text-muted); }
.button--quiet:hover { background: var(--surface-3); color: var(--text); }
.button--sm { min-height: 28px; padding: 0 8px; font-size: var(--text-xs); }
.button--block { width: 100%; }
.button[disabled], .button[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.button--working { pointer-events: none; }

/* Tabs */
.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tabs__item {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 40px; padding: 0 12px;
  border-bottom: 2px solid transparent;
  color: var(--text-muted); text-decoration: none; font-size: var(--text-base);
  white-space: nowrap;
}
.tabs__item:hover { color: var(--text); }
.tabs__item--current { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }

/* Banners and states */
.banner {
  display: flex; align-items: flex-start; gap: 12px;
  margin-bottom: 16px; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface);
}
.banner__icon { display: inline-flex; color: var(--accent); margin-top: 1px; }
.banner__title { font-weight: 600; font-size: var(--text-sm); }
.banner__message { font-size: var(--text-sm); }
.banner--success { background: var(--ok-bg); border-color: var(--ok-text); color: var(--ok-text); }
.banner--success .banner__icon { color: var(--ok-text); }
.banner--error { background: var(--blocked-bg); border-color: var(--blocked-text); color: var(--blocked-text); }
.banner--error .banner__icon { color: var(--blocked-text); }
.banner--warning { background: var(--grace-bg); border-color: var(--grace-text); color: var(--grace-text); }
.banner--warning .banner__icon { color: var(--grace-text); }
.banner--info { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }

.state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 16px; text-align: center; }
.state__icon { color: var(--text-faint); }
.state__icon--error { color: var(--blocked-text); }
.state__title { font-size: var(--text-md); font-weight: 500; }
.state__body { color: var(--text-muted); font-size: var(--text-sm); max-width: 46ch; }
.state .button { margin-top: 8px; }

/* Chart */
.chart { min-width: 0; }
.chart__legend { display: flex; flex-wrap: wrap; gap: 16px; list-style: none; margin-bottom: 8px; }
.chart__legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--text-xs); }
.chart__swatch { display: inline-block; width: 18px; height: 2px; background: currentColor; }
.chart__swatch--accent { color: var(--accent); }
.chart__swatch--ok { color: var(--ok-text); }
.chart__swatch--soft { color: var(--soft-text); }
.chart__swatch--grace { color: var(--grace-text); }
.chart__swatch--blocked { color: var(--blocked-text); }
.chart__swatch--muted { color: var(--text-faint); }
.chart__swatch--dash { background: none; border-top: 2px dashed currentColor; height: 0; }
.chart__svg { display: block; width: 100%; height: auto; }
.chart__grid { stroke: var(--border); stroke-width: 1; }
.chart__axis-label { fill: var(--text-muted); font-size: 12px; font-family: var(--font-sans); }
.chart__line--accent { stroke: var(--accent); }
.chart__line--ok { stroke: var(--ok-text); }
.chart__line--soft { stroke: var(--soft-text); }
.chart__line--grace { stroke: var(--grace-text); }
.chart__line--blocked { stroke: var(--blocked-text); }
.chart__line--muted { stroke: var(--text-faint); }
.chart__point--accent { fill: var(--accent); stroke: var(--surface); stroke-width: 1; }
.chart__point--ok { fill: var(--ok-text); stroke: var(--surface); stroke-width: 1; }
.chart__point--soft { fill: var(--soft-text); stroke: var(--surface); stroke-width: 1; }
.chart__point--grace { fill: var(--grace-text); stroke: var(--surface); stroke-width: 1; }
.chart__point--blocked { fill: var(--blocked-text); stroke: var(--surface); stroke-width: 1; }
.chart__point--muted { fill: var(--text-faint); stroke: var(--surface); stroke-width: 1; }
.chart__point:focus-visible { outline: none; stroke: var(--focus); stroke-width: 3; }
.chart__swatch--block { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
.chart__bar { shape-rendering: crispEdges; }

/* Usage */
.usage-custom { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 16px; }
.usage-custom .field { margin-bottom: 0; flex: 1 1 150px; max-width: 220px; }
.usage-custom__action { display: flex; align-items: flex-end; }
.usage-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 0; }
.usage-summary > div { min-width: 0; }
.usage-table__sub { display: block; color: var(--text-faint); font-size: var(--text-xs); }
.card__actions .tabs { margin-bottom: 0; border-bottom: 0; }
.card__actions .tabs__item { min-height: 32px; }

/* Requests */
.split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 16px; align-items: start; }.request-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.request-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px;
  min-width: 0;
}
.request-card--selected { border-color: var(--accent); background: var(--accent-soft); }
.request-card--blocked { border-left: 3px solid var(--blocked-text); }
.request-card__top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.request-card__name { font-weight: 500; }
.request-card__link { color: var(--text); text-decoration: none; }
.request-card__link:hover { text-decoration: underline; }
.request-card__meta { margin-top: 4px; color: var(--text-muted); font-size: var(--text-xs); }
.request-card__reason { margin-top: 6px; font-size: var(--text-sm); overflow-wrap: anywhere; }
.request-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.quick-actions { display: none; gap: 8px; margin-top: 8px; }
.quick-actions form { flex: 1; min-width: 0; }
.detail-back { display: none; }
.detail__message { margin: 8px 0 0; font-size: var(--text-base); line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail__hint {
  margin-top: 12px; padding: 8px 12px;
  background: var(--surface-2); border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.context-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-top: 12px; }
.context-grid .metric__value { font-size: var(--text-lg); line-height: 28px; }
.decision-box { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
.decision-box h3 { font-size: var(--text-md); font-weight: 500; margin-bottom: 8px; }
details.disclosure { margin-top: 8px; }
details.disclosure > summary { cursor: pointer; color: var(--accent); font-size: var(--text-sm); min-height: 32px; display: flex; align-items: center; }
details.disclosure > summary:hover { color: var(--accent-hover); }
.decision-outcome { display: flex; flex-direction: column; gap: 8px; }
.actionbar { display: none; }

/* Grants and key */
.grant-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.grant-row:last-child { border-bottom: 0; }
.key-state { display: flex; align-items: center; gap: 8px; }

/* Audit */
.audit-details summary { cursor: pointer; color: var(--text-muted); font-size: var(--text-xs); min-height: 24px; display: inline-flex; align-items: center; }
.audit-details pre { margin-top: 8px; }
.audit-json { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.filter-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; align-items: end; margin-bottom: 16px; }
.filter-bar .field { margin-bottom: 0; }

/* Toasts */
.toasts {
  position: fixed; right: 24px; bottom: 24px; z-index: 80;
  display: flex; flex-direction: column; gap: 8px;
  width: min(360px, calc(100vw - 32px));
}
.toast {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
}
.toast--success { border-color: var(--ok-text); }
.toast--error { border-color: var(--blocked-text); }
.toast__text { flex: 1; min-width: 0; }
.toast__title { font-weight: 600; }
.toast__close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; flex: 0 0 auto;
  background: transparent; border: 0; border-radius: var(--radius-sm);
  color: var(--text-muted); cursor: pointer;
}
.toast__close:hover { background: var(--surface-3); color: var(--text); }

.spinner {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 700ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-inline { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--text-sm); }
.secret {
  margin-top: 8px; padding: 12px;
  background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: var(--text-sm);
  overflow-wrap: anywhere; user-select: all;
}
.empty-note { padding: 16px; color: var(--text-muted); font-size: var(--text-sm); text-align: center; }
.member-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.member-name a { color: var(--text); text-decoration: none; }
.member-name a:hover { text-decoration: underline; }
.member-name__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alerts { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.alerts__item { display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: var(--text-sm); }
.alerts__item:last-child { border-bottom: 0; }
.alerts__item .icon { color: var(--text-faint); margin-top: 1px; }
.doctor-ok { color: var(--ok-text); font-weight: 500; }
.doctor-bad { color: var(--blocked-text); font-weight: 500; }

/* Sign in */
.login-body { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 16px; }
.login { width: 100%; max-width: 420px; }
.login__card { width: 100%; }
.login__foot { margin-top: 16px; text-align: center; }

/* Tablet */
@media (max-width: 1023px) {
  .col-3, .col-4, .col-5, .col-6, .col-7, .col-8, .col-9 { grid-column: span 12; }
  .split { grid-template-columns: 1fr; }
  .main { padding: 24px; }
}

/* Phone */
@media (max-width: 767px) {
  .topbar { height: 48px; padding: 0 12px; gap: 8px; }
  .brand__name, .topbar__divider, .topbar__team, .topbar__middle, .topbar__control-label { display: none; }
  .topbar__mobile-title {
    display: block; flex: 1; min-width: 0;
    font-size: var(--text-base); font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .topbar__actions { gap: 2px; }
  .topbar__control, .topbar__user { padding: 0 6px; }
  .sidenav { display: none; }
  .shell { grid-template-columns: 1fr; }
  .main { padding: 16px 16px 40px; }
  .page-body { padding-bottom: calc(56px + env(safe-area-inset-bottom)); }
  .page__header { flex-direction: column; align-items: stretch; gap: 12px; }
  .page__actions .button, .page__actions form { width: 100%; }
  .page__actions form .button { width: 100%; }
  .grid { grid-template-columns: minmax(0, 1fr); }
  .col-3, .col-4, .col-5, .col-6, .col-7, .col-8, .col-9, .col-12 { grid-column: 1 / -1; }
  .card--primary { padding: 16px; }
  .button { min-height: 40px; }
  .button--sm { min-height: 36px; }
  input[type="text"], input[type="email"], input[type="password"], input[type="search"],
  input[type="number"], input[type="date"], select { min-height: 40px; }
  .tabs__item { min-height: 44px; }
  th, td { padding: 12px; }
  .quick-actions { display: flex; }
  .quick-actions .button { flex: 1; }
  .split { gap: 12px; }
  .actionbar {
    display: flex; gap: 8px;
    position: fixed; left: 12px; right: 12px;
    bottom: calc(64px + env(safe-area-inset-bottom));
    z-index: 30;
    padding: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
  }
  .actionbar .button { flex: 1; min-height: 44px; }
  .page--request-detail { padding-bottom: 96px; }
  .detail-actions-inline { display: none; }
  .detail-back { display: inline-flex; align-items: center; min-height: 32px; }
  .request-detail--empty { display: none; }
  .split--detail .request-list-card { display: none; }
  .toasts { right: 16px; bottom: calc(64px + env(safe-area-inset-bottom)); }

  .table--cards thead {
    position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);
  }
  .table--cards, .table--cards tbody, .table--cards tr, .table--cards td, .table--cards th { display: block; width: 100%; }
  .table--cards tr {
    margin-bottom: 8px; padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .table--cards tbody tr:hover { background: var(--surface); }
  .table--cards td, .table--cards th {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 5px 0; border: 0; text-align: right;
  }
  .table--cards td::before, .table--cards th::before {
    content: attr(data-label);
    color: var(--text-muted); font-family: var(--font-sans); font-weight: 400; font-size: var(--text-xs);
    text-align: left;
  }
  .table--cards tr > :first-child {
    padding-bottom: 8px; margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-base);
  }
  .table--cards tr > :first-child::before { content: none; }
  .table--cards .member-name { justify-content: flex-start; }
  .card__header { flex-direction: column; align-items: flex-start; gap: 8px; }
  .card__actions { width: 100%; justify-content: flex-start; }
  .table--cards caption { display: block; width: 100%; padding: 0 0 8px; text-align: left; }
  .table--cards tr > :first-child { flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
  .usage-chart { overflow-x: auto; }
  .usage-chart .chart__svg { min-width: 560px; }
  .audit-json { grid-template-columns: minmax(0, 1fr); }
  .check__label .mono { margin-right: 4px; }
  .check__label .field__hint { display: block; margin-top: 2px; }

  .bottomnav {
    display: flex;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
    height: calc(56px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .bottomnav__item {
    position: relative;
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    min-width: 0; padding: 4px 2px;
    color: var(--text-muted); text-decoration: none;
    font-size: var(--text-xs);
    cursor: pointer;
    list-style: none;
  }
  .bottomnav__item::-webkit-details-marker { display: none; }
  .bottomnav__item--current { color: var(--accent); font-weight: 500; }
  .bottomnav__label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bottomnav__icon .icon { width: 20px; height: 20px; }
  .bottomnav__more { flex: 1; display: flex; }
  .bottomnav__more > summary { flex: 1; }
  .sheet {
    position: absolute; right: 8px; bottom: calc(100% + 8px);
    min-width: 200px; padding: 8px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-pop);
  }
  .sheet__title { padding: 4px 8px; color: var(--text-muted); font-size: var(--text-xs); font-weight: 600; }
  .sheet__list { list-style: none; }
  .sheet__item {
    display: flex; align-items: center; gap: 8px;
    min-height: 44px; padding: 0 8px;
    color: var(--text); text-decoration: none; font-size: var(--text-base);
    border-radius: var(--radius-sm);
  }
  .sheet__item:hover { background: var(--surface-3); }
  .menu__panel { position: fixed; right: 12px; top: 52px; }
}

@media (min-width: 768px) {
  .detail-actions-inline { display: flex; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .spinner { animation: none; border-right-color: currentColor; opacity: 0.6; }
}

@media print {
  .topbar, .sidenav, .bottomnav, .toasts, .actionbar { display: none; }
  body { background: #ffffff; color: #000000; }
  .card { box-shadow: none; }
}
`;
