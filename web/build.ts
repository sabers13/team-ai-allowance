/**
 * Build `dist/team-ai-allowance/index.html`.
 *
 * The page is one self-contained HTML file plus local PNGs. It has no script
 * dependency, no web font, no CDN and no analytics; the only external link is
 * the GitHub repository. `buildPageData` refuses to run when a source number is
 * missing, and every figure below is interpolated from that data.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPageData,
  type PageData,
  type SimScenario,
  type TeamScenario,
} from "../src/report/page-data.ts";

const root = process.cwd();
const outDir = join(root, "dist/team-ai-allowance");
const shotsDir = join(outDir, "shots");
const css = readFileSync(join(root, "web/page.css"), "utf8");
const data = buildPageData(root);

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function usd(value: number, digits = 6): string {
  return `USD ${value.toFixed(digits)}`;
}

function num(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

function dateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const text = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return `${text} UTC`;
}

function dateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function timeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function weekdayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "the weekend window";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(date);
}

function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "under a minute";
  return `${value} min`;
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function statusChip(pass: boolean, yes = "passed", no = "failed"): string {
  return `<span class="chip ${pass ? "is-ok" : "is-blocked"}">${esc(pass ? yes : no)}</span>`;
}

function scenarioChip(scenario: TeamScenario): string {
  if (scenario.pass) return `<span class="chip is-ok">passed</span>`;
  if (scenario.partial) return `<span class="chip is-soft">partial</span>`;
  return `<span class="chip is-blocked">failed</span>`;
}

function decidedBy(value: string): string {
  if (value.startsWith("rule:")) return `Rule · ${value.slice(5)}`;
  if (value.startsWith("manager:")) return "Leader (manager)";
  return value;
}

/* ------------------------------------------------------------------ chart */

function renderChart(simulation: PageData["simulation"]): string {
  const seriesClass: Record<string, string> = {
    "no-limits": "series-no-limits",
    "budget-only": "series-budget",
    "off-hours-only": "series-offhours",
    "all-limits": "series-all",
  };
  const descriptions = simulation.scenarios
    .map(
      (scenario) =>
        `${scenario.title}: stopped at ${usd(scenario.stop.spendUsd, 2)}. ${scenario.stop.detail}`,
    )
    .join(" ");

  const draw = (compact: boolean): string => {
    const width = compact ? 360 : 900;
    const height = compact ? 260 : 340;
    const left = compact ? 56 : 70;
    const right = compact ? 12 : 54;
    const top = compact ? 16 : 22;
    const bottom = compact ? 38 : 46;
    const start = Date.parse(simulation.scenarios[0]?.points[0]?.t ?? "");
    const end = Date.parse(simulation.weekendEnd);
    const yMax = 150;
    const x = (iso: string): number => {
      const t = Date.parse(iso);
      return left + ((t - start) / (end - start)) * (width - left - right);
    };
    const y = (value: number): number => top + (1 - value / yMax) * (height - top - bottom);
    const suffix = compact ? "mobile" : "desktop";

    const paths = simulation.scenarios
      .map((scenario) => {
        if (scenario.points.length === 0) return "";
        const commands = scenario.points
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${x(point.t).toFixed(1)} ${y(point.spendUsd).toFixed(1)}`,
          )
          .join(" ");
        return `<path class="series ${seriesClass[scenario.scenario] ?? ""}" d="${commands}" />`;
      })
      .join("\n");

    const stops = simulation.scenarios
      .map((scenario) => {
        const point = { x: x(scenario.stop.t), y: y(scenario.stop.spendUsd) };
        const nearRight = point.x > width - right - 110;
        const labelX = nearRight ? point.x - 8 : point.x + 8;
        const anchor = nearRight ? "end" : "start";
        const label = compact
          ? ""
          : `<text x="${labelX.toFixed(1)}" y="${(point.y - 7).toFixed(1)}" text-anchor="${anchor}">${esc(usd(scenario.stop.spendUsd, 2))}</text>`;
        return `<g class="stop ${seriesClass[scenario.scenario] ?? ""}">
          <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${esc(scenario.title)} stopped at ${esc(usd(scenario.stop.spendUsd, 2))}</title></circle>
          ${label}
        </g>`;
      })
      .join("\n");

    const grids = [0, 50, 100, 150]
      .map(
        (value) =>
          `<g><line class="grid" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" /><text class="axis" x="${left - 8}" y="${y(value) + 4}" text-anchor="end">USD ${value}</text></g>`,
      )
      .join("");

    const tickCount = compact ? 3 : 5;
    const ticks = Array.from({ length: tickCount }, (_, index) => {
      const t = start + ((end - start) * index) / (tickCount - 1);
      const label = new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Europe/Berlin",
      }).format(new Date(t));
      const anchor = index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle";
      const tickX = index === tickCount - 1 ? width - right : x(new Date(t).toISOString());
      return `<text class="axis" x="${tickX.toFixed(1)}" y="${height - 12}" text-anchor="${anchor}">${esc(label)}</text>`;
    }).join("");

    return `<svg class="chart chart-${suffix}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title-${suffix} chart-desc-${suffix}">
      <title id="chart-title-${suffix}">Simulated spend over one weekend in four scenarios</title>
      <desc id="chart-desc-${suffix}">${esc(descriptions)}</desc>
      ${grids}
      <line class="axis-line" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" />
      ${paths}
      ${stops}
      ${ticks}
    </svg>`;
  };

  return `<figure class="chart-figure">
    <div class="chart-scroll" tabindex="0" role="region" aria-label="Simulation chart">
      ${draw(false)}
      ${draw(true)}
    </div>
    <p class="chart-hint">Times are Europe/Berlin. The table below has the same numbers.</p>
  </figure>`;
}

function simRow(scenario: SimScenario): string {
  return `<tr>
    <th scope="row">${esc(scenario.title)}</th>
    <td>${esc(scenario.stop.reason.replaceAll("_", " "))}</td>
    <td class="num">${num(scenario.stop.step)}</td>
    <td class="num">${esc(usd(scenario.stop.spendUsd, 2))}</td>
    <td>${esc(scenario.stop.detail)}</td>
  </tr>`;
}

/* ------------------------------------------------------------------- live */

function liveCard(cli: PageData["live"]["clis"][number]): string {
  const steps = cli.steps
    .map(
      (step) => `<li>
        <span class="live-step-name">${esc(step.label)}</span>
        <span class="live-step-detail">${esc(step.detail)}</span>
        ${statusChip(step.pass)}
      </li>`,
    )
    .join("");
  return `<article class="live-card">
    <div class="live-card-head">
      <h3>${esc(cli.cli === "claude" ? "Claude Code" : cli.cli === "opencode" ? "OpenCode" : "Codex")}</h3>
      <span class="mono muted">${esc(cli.version)}</span>
    </div>
    <ul class="live-steps">${steps}</ul>
  </article>`;
}

/* --------------------------------------------------------------- team test */

function scenarioCard(scenario: TeamScenario): string {
  const events = scenario.expected
    .map(
      (event) => `<li class="event ${event.happened ? "did" : "did-not"}">
        <span class="event-mark" aria-hidden="true">${event.happened ? "✓" : "×"}</span>
        <div>
          <p class="event-name">${esc(event.event)} <span class="visually-hidden">${event.happened ? "happened" : "did not happen"}</span></p>
          <p class="event-meta">${event.happened ? "happened" : "did not happen"}${event.at === null ? "" : ` · ${esc(dateTime(event.at))}`}</p>
          <p class="event-evidence">${esc(event.evidence)}</p>
        </div>
      </li>`,
    )
    .join("");
  const notes = scenario.notes.map((note) => `<li>${esc(note)}</li>`).join("");
  return `<article class="scenario">
    <div class="scenario-head">
      <div><p class="mono muted">${esc(scenario.id.toUpperCase())} · ${esc(scenario.member)} · ${esc(scenario.team)}</p>
      <h3>${esc(scenario.title)}</h3></div>
      ${scenarioChip(scenario)}
    </div>
    <p class="scenario-spend"><span class="mono">${esc(usd(scenario.spendUsd))}</span> metered spend</p>
    <ol class="events">${events}</ol>
    ${notes === "" ? "" : `<ul class="scenario-notes">${notes}</ul>`}
  </article>`;
}

function decisionItem(decision: PageData["teamTest"]["decisions"][number]): string {
  const outcomeClass =
    decision.outcome === "approved"
      ? "is-ok"
      : decision.outcome === "denied"
        ? "is-blocked"
        : "is-soft";
  return `<li class="timeline-item">
    <div class="timeline-when"><time datetime="${esc(decision.at)}">${esc(dateTime(decision.at))}</time></div>
    <div class="timeline-card">
      <div class="timeline-head">
        <h4>${esc(decision.memberName)} · ${esc(decision.kind)}${decision.detail === "" ? "" : ` ${esc(decision.detail)}`}</h4>
        <span class="chip ${outcomeClass}">${esc(decision.outcome)}</span>
      </div>
      <p class="timeline-flow"><span>filed ${esc(timeShort(decision.filedAt))}</span><span class="arrow" aria-hidden="true">→</span><span>decided ${esc(timeShort(decision.at))}</span><span class="chip is-quiet">${esc(minutes(decision.minutesToDecision))}</span></p>
      <p class="timeline-note">“${esc(decision.note)}”</p>
      <p class="timeline-by">${esc(decidedBy(decision.decidedBy))}</p>
    </div>
  </li>`;
}

function probeRow(probe: PageData["teamTest"]["probes"][number]): string {
  return `<tr>
    <th scope="row">${esc(probe.title)}</th>
    <td>${esc(probe.expected)}</td>
    <td>${esc(probe.observed)}</td>
    <td>${statusChip(probe.pass)}</td>
  </tr>`;
}

function wrongItem(item: { summary: string; detail: string }, index: number): string {
  return `<details class="wrong-item">
    <summary><span class="wrong-number">${String(index).padStart(2, "0")}</span><span>${esc(item.summary)}</span></summary>
    <p>${esc(item.detail)}</p>
  </details>`;
}

function shotCard(shot: PageData["teamTest"]["shots"][number]): string {
  const desktop = pngSize(join(root, "results/dogfood", shot.file));
  const mobile = pngSize(join(root, "results/dogfood", shot.mobileFile));
  const copied = `shots/${shot.file}`;
  const copiedMobile = `shots/${shot.mobileFile}`;
  return `<figure class="shot">
    <a class="shot-frame" href="${esc(copied)}" target="_blank" rel="noopener">
      <picture>
        <source media="(max-width: 700px)" srcset="${esc(copiedMobile)}">
        <img src="${esc(copied)}" width="${desktop.width}" height="${desktop.height}" alt="${esc(shot.label)}" loading="lazy">
      </picture>
    </a>
    <figcaption><strong>${esc(shot.label)}</strong><span>${esc(shot.caption)}</span><a href="${esc(copied)}" target="_blank" rel="noopener">Open full size<span class="visually-hidden"> (${esc(shot.label)})</span></a></figcaption>
    <span class="visually-hidden">Mobile image is ${mobile.width} by ${mobile.height} pixels.</span>
  </figure>`;
}

/* --------------------------------------------------------------- template */

const livePassed = data.summary.liveStepsPassed;
const liveTotal = data.summary.liveStepsTotal;
const zeroPct = Math.round((data.summary.zeroCostRows / data.summary.totalRows) * 100);
const streamingIssue = data.teamTest.whatWentWrong.find((item) =>
  item.summary.includes("costUsd 0"),
);
const otherWrong = data.teamTest.whatWentWrong.filter((item) => item !== streamingIssue);
const simulation = data.simulation;
const team = data.teamTest;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team AI allowance — shared AI limits a member cannot switch off</title>
<meta name="description" content="A team gateway, a manager console and a request desk inside the CLI. Tested on a real four-agent team.">
<meta name="color-scheme" content="light dark">
<script>
(() => {
  try {
    const stored = localStorage.getItem("taa-theme");
    if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
  } catch {}
})();
</script>
<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="#top" aria-label="Team AI allowance, back to top">
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5"/><path d="M7 12.2 10.2 15.4 17.2 8.6"/></svg>
      <span>team-ai-allowance</span>
    </a>
    <nav class="site-nav" aria-label="Page sections">
      <a href="#how">How it works</a>
      <a href="#flow">Request flow</a>
      <a href="#simulation">Simulation</a>
      <a href="#live">Live check</a>
      <a href="#team">Team test</a>
      <a href="#setup">Setup</a>
    </nav>
    <div class="header-actions">
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to dark theme">Dark</button>
      <a class="source-link" href="https://github.com/sabers13/team-ai-allowance" rel="noopener">GitHub <span aria-hidden="true">↗</span></a>
    </div>
  </div>
</header>

<main id="main">
  <section class="hero" id="top">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow"><span class="pulse" aria-hidden="true"></span> Independent project · v1.0</p>
        <h1>How does a team share AI coding tools without surprise bills, and without blocking people who need more?</h1>
        <p class="lede">A team gateway holds the provider keys and checks every member's models and spend limit before a request goes through. A manager console shows the spend and decides requests; an MCP desk lets a member ask from inside the terminal.</p>
        <div class="hero-actions">
          <a class="button primary" href="#how">See how it works</a>
          <a class="button secondary" href="#team">Read the team test</a>
        </div>
      </div>
      <aside class="answer-card" aria-label="The short answer">
        <p class="card-kicker">The short answer</p>
        <ol class="answer-list">
          <li><span class="answer-number">1</span><p><strong>Members never hold the provider key.</strong> They get a personal gateway key that can only reach the team's models.</p></li>
          <li><span class="answer-number">2</span><p><strong>The gateway checks first.</strong> Model access, budget and rate limits are applied by the proxy before the provider sees a call.</p></li>
          <li><span class="answer-number">3</span><p><strong>Asking is built in.</strong> When a limit is close, a member can request more from the CLI; the manager approves, partly approves or denies with a note.</p></li>
        </ol>
      </aside>
    </div>
    <div class="wrap">
      <dl class="hero-facts">
        <div><dt>CLIs verified live</dt><dd>${data.summary.clisVerified}</dd></div>
        <div><dt>Live steps passed</dt><dd>${livePassed}<span class="of">/${liveTotal}</span></dd></div>
        <div><dt>Scripted probes passed</dt><dd>${data.summary.probesPassed}<span class="of">/${data.summary.probesTotal}</span></dd></div>
        <div><dt>Team-test spend</dt><dd class="money">${esc(usd(data.summary.teamSpendUsd))}</dd></div>
      </dl>
    </div>
  </section>

  <section class="section problem" aria-labelledby="problem-title">
    <div class="wrap narrow">
      <p class="kicker">01 · The problem</p>
      <h2 id="problem-title">The bill arrives before the rule does.</h2>
      <p class="big-copy">Teams hand out AI coding CLIs that bill the company directly. Limits are missing, or set once and changed only by ticket. A session left running over a weekend can cost more than a laptop, while the one person who needs a stronger model waits.</p>
      <div class="tension-grid">
        <div class="tension"><span class="tension-mark" aria-hidden="true">→</span><h3>No ceiling</h3><p>One forgotten session keeps calling the model after everyone has gone home.</p></div>
        <div class="tension"><span class="tension-mark" aria-hidden="true">→</span><h3>No fast exception</h3><p>The person who needs the flagship model for one hard task waits for a ticket or gives up.</p></div>
        <div class="tension"><span class="tension-mark" aria-hidden="true">→</span><h3>No shared record</h3><p>Nobody can say which member, model or period produced the bill without reading provider invoices.</p></div>
      </div>
    </div>
  </section>

  <section class="section" id="how" aria-labelledby="how-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">02 · How it works</p>
        <h2 id="how-title">Limits the member cannot switch off</h2>
        <p class="section-lede">The member's machine runs an ordinary CLI. The provider key, the model allowlist and the budget live on the team server, behind a gateway the member does not control.</p>
      </div>

      <div class="arch" role="img" aria-label="Architecture: member CLIs and MCP tools reach the LiteLLM gateway; the control service manages teams, limits, grants, requests and audit; the manager uses the console; notifications leave the control service. The gateway holds the provider keys.">
        <div class="arch-panel">
          <p class="arch-label">On the member machine</p>
          <div class="arch-box"><strong>Any coding CLI</strong><span>Claude Code · OpenCode · Codex · other MCP-capable CLIs</span></div>
          <div class="arch-box"><strong>MCP request desk</strong><span><code>taa mcp</code> · check allowance, ask for more, ask for a model</span></div>
          <div class="arch-box quiet"><strong>Optional plugin</strong><span>in-session pause rules; an extra guard, not the limit</span></div>
        </div>
        <div class="arch-panel arch-server">
          <p class="arch-label">On the team server</p>
          <div class="arch-box accent"><strong>LiteLLM gateway</strong><span>holds the provider keys · enforces model list, budget and rate limits per key</span></div>
          <div class="arch-box"><strong>Control service</strong><span>teams, members, limits, grants, requests, rules, audit · reconciler applies policy, watcher reads spend</span></div>
          <div class="arch-box"><strong>Console and notices</strong><span>manager web console · Teams, Slack, e-mail or webhook</span></div>
        </div>
        <div class="arch-panel">
          <p class="arch-label">For the manager</p>
          <div class="arch-box"><strong>Console</strong><span>spend per member and model, limits, requests, audit</span></div>
          <div class="arch-box"><strong>Manager tools</strong><span>the same decisions from an MCP client or the API</span></div>
        </div>
      </div>
      <p class="arch-caption">Model requests carry a personal gateway key. The gateway checks the key before a provider sees the call; the reconciler keeps the key's policy in sync after every change and every five minutes.</p>

      <div class="why-grid">
        <article class="why"><p class="mono muted">Why 01</p><h3>The provider key is not on the laptop</h3><p>A member receives one personal gateway key. Removing the CLI, editing its config or starting a parallel session changes what the laptop sends, not what the gateway allows.</p></article>
        <article class="why"><p class="mono muted">Why 02</p><h3>The check happens before the model</h3><p>LiteLLM enforces the model allowlist, the budget duration and the rate limits on every request. The watcher adds token caps, off-hours caps and alerts on top.</p></article>
        <article class="why"><p class="mono muted">Why 03</p><h3>A local change cannot widen the key</h3><p>The setup pack points each CLI at the gateway and removes other providers. If a member deletes those files, the CLI still has no provider key and no route to the team's models.</p></article>
      </div>
      <div class="residual-note"><strong>The honest edge:</strong> a member who brings a personal provider key, or a root user who edits the managed files, is outside this boundary. The <a href="#limits">limits section</a> says what remains and what does not.</div>
    </div>
  </section>

  <section class="section alt" id="flow" aria-labelledby="flow-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">03 · The request flow</p>
        <h2 id="flow-title">A limit, a question, a decision</h2>
        <p class="section-lede">The demo follows one afternoon in the console: Lena reaches her budget, asks from inside the CLI, and Priya approves part of it. The screenshots are from the committed demo run, not a mock-up.</p>
      </div>
      <p class="demo-label"><span class="chip is-quiet">Demo</span> Mock upstream · fixed clock ${esc(dateTime(data.demo.clock))} · generated by <code>${esc(data.meta.demoGeneratedBy)}</code></p>
      <ol class="flow-list">
        ${data.demo.steps
          .map(
            (step) => `<li class="flow-card">
              <a class="flow-shot" href="shots/${esc(step.file)}" target="_blank" rel="noopener">
                <img src="shots/${esc(step.file)}" width="${step.width}" height="${step.height}" alt="Demo step ${step.step}: ${esc(step.name)}" loading="lazy">
              </a>
              <div class="flow-copy">
                <span class="flow-number">${String(step.step).replace(".5", "b").padStart(2, "0")}</span>
                <h3>${esc(step.name)}</h3>
                <p>${esc(step.observed)}</p>
              </div>
            </li>`,
          )
          .join("")}
      </ol>
    </div>
  </section>

  <section class="section" id="simulation" aria-labelledby="sim-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">04 · The weekend</p>
        <h2 id="sim-title">What a forgotten session costs</h2>
        <p class="section-lede">Four deterministic runs of the same agent loop from ${esc(weekdayTime(simulation.weekendStart))} to ${esc(weekdayTime(simulation.weekendEnd))}. This is a simulation with a fake clock and example list prices, not a measurement.</p>
      </div>
      <div class="sim-banner"><span class="chip is-soft">Simulation</span><p>${esc(simulation.scenarios[0]?.assumptions[0] ?? "Simulation, not a measurement.")}</p></div>
      ${renderChart(simulation)}
      <div class="legend" aria-label="Chart legend">
        <span><i class="line no-limits"></i>No limits</span>
        <span><i class="line budget"></i>Budget only</span>
        <span><i class="line offhours"></i>Off-hours cap only</span>
        <span><i class="line all"></i>Every limit on</span>
        <span class="muted">A dot marks the stop.</span>
      </div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Simulation results at the stop">
        <table class="data-table">
          <caption class="visually-hidden">Simulation results at the stop</caption>
          <thead><tr><th scope="col">Run</th><th scope="col">Stopped by</th><th scope="col" class="num">Step</th><th scope="col" class="num">Spend at stop</th><th scope="col">What happened</th></tr></thead>
          <tbody>${simulation.scenarios.map(simRow).join("")}</tbody>
        </table>
      </div>
      <details class="assumptions">
        <summary>Assumptions behind the simulation</summary>
        <ul>${simulation.scenarios[0]?.assumptions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
        <p class="muted">Window: ${esc(simulation.weekendStart)} to ${esc(simulation.weekendEnd)} · prices from <code>config/prices.json</code> · the same files are the source for every number in this section.</p>
      </details>
    </div>
  </section>

  <section class="section alt" id="live" aria-labelledby="live-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">05 · The live check</p>
        <h2 id="live-title">It works from the real CLIs</h2>
        <p class="section-lede">Three CLIs, each pointed at a real gateway with a real model and a small test budget. Every step passed. The gateway refused what it should refuse, and the MCP request came back approved.</p>
      </div>
      <div class="live-summary">
        <p><strong>${data.summary.clisVerified} CLIs</strong> · ${livePassed} of ${liveTotal} steps passed · ${esc(usd(data.live.totalSpendUsd))} test-denominated gateway spend</p>
        <p class="muted">Run ${esc(dateTime(data.live.runAt))} · upstream stop tripped: <strong>${data.live.upstreamStopTripped ? "yes" : "no"}</strong></p>
      </div>
      <div class="live-grid">${data.live.clis.map(liveCard).join("")}</div>
      <div class="plugin-note">
        <div>${statusChip(data.live.plugin.pass)}<h3>OpenCode plugin</h3></div>
        <p>The unattended rule paused the loop. The plugin is an extra in-session guard; the gateway remains the exact budget enforcer.</p>
        <p class="mono muted">${esc(usd(data.live.plugin.spendUsd))} across the plugin check</p>
      </div>
    </div>
  </section>

  <section class="section" id="team" aria-labelledby="team-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">05a · Tested on a real AI team</p>
        <h2 id="team-title">Four worker agents, tiny limits</h2>
        <p class="section-lede">An orchestrator agent led the main Crew team; a second Night team covered off-hours. Four worker agents did small real coding tasks through the allowance gateway; extra probe members checked the edges. Every limit was set tiny on purpose so the product had to bite on real traffic.</p>
      </div>
      <dl class="team-facts">
        <div><dt>Window</dt><dd>${esc(dateShort(team.window.from))} → ${esc(dateShort(team.window.to))}</dd></div>
        <div><dt>Crew</dt><dd>${team.teams.find((item) => item.name === "Crew")?.members ?? 0} members · ${team.teams.find((item) => item.name === "Crew")?.requests ?? 0} requests</dd></div>
        <div><dt>Night</dt><dd>${team.teams.find((item) => item.name === "Night")?.members ?? 0} members · ${team.teams.find((item) => item.name === "Night")?.requests ?? 0} requests</dd></div>
        <div><dt>Gateway spend</dt><dd class="money">${esc(usd(team.spend.totalUsd))}</dd></div>
      </dl>

      <div class="scenario-grid">${team.scenarioSummary.map(scenarioCard).join("")}</div>

      <div class="subhead">
        <h3>Request → decision</h3>
        <p>All ${team.decisions.length} decisions in the export, oldest first. “Filed” is when the member asked; the note is what the member saw.</p>
      </div>
      <ol class="timeline">${[...team.decisions]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map(decisionItem)
        .join("")}</ol>

      <div class="subhead">
        <h3>Scripted probes</h3>
        <p>${team.probesPassed} of ${team.probesTotal} probes passed. They used direct gateway and API calls, with no agent in the loop, and cost ${esc(usd(team.probeCostUsd))}.</p>
      </div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Scripted probe results">
        <table class="data-table probes">
          <caption class="visually-hidden">Scripted probe results</caption>
          <thead><tr><th scope="col">Probe</th><th scope="col">Expected</th><th scope="col">Observed</th><th scope="col">Result</th></tr></thead>
          <tbody>${team.probes.map(probeRow).join("")}</tbody>
        </table>
      </div>

      <div class="subhead">
        <h3>What went wrong</h3>
        <p>The test is published with its failures. ${streamingIssue === undefined ? "" : `The first finding is the one that changes how to read the spend figures.`}</p>
      </div>
      ${
        streamingIssue === undefined
          ? ""
          : `<div class="wrong-highlight">
              <p class="mono muted">The finding that matters</p>
              <h4>${esc(streamingIssue.summary)}</h4>
              <p>${esc(streamingIssue.detail)}</p>
              <p class="wrong-consequence">That is ${zeroPct}% of gateway rows: ${num(data.summary.zeroCostRows)} of ${num(data.summary.totalRows)} rows carried ${num(data.summary.zeroCostTokens)} tokens with no cost. The hard limit in the test was still reached with priced metered calls; the off-hours cap never fired because its spend never crossed the cap.</p>
            </div>`
      }
      <div class="wrong-list">${otherWrong.map((item, index) => wrongItem(item, index + 2)).join("")}</div>

      <div class="subhead">
        <h3>The console after the test</h3>
        <p>These are the real Crew pages at the end of the run. Open any shot for the full-size image.</p>
      </div>
      <div class="shots-grid">${team.shots.map(shotCard).join("")}</div>
    </div>
  </section>

  <section class="section alt" id="setup" aria-labelledby="setup-title">
    <div class="wrap">
      <div class="section-head">
        <p class="kicker">06 · Setup</p>
        <h2 id="setup-title">Four steps to a team allowance</h2>
        <p class="section-lede">The default stack is for a local evaluation. A production install uses the same pieces with your own LiteLLM deployment and provider keys.</p>
      </div>
      <ol class="steps">
        <li>
          <span class="step-number">01</span>
          <h3>Start the gateway</h3>
          <p>The gateway holds the provider keys and enforces per-key models and budgets. In the repository, one command starts LiteLLM, Postgres, the control service, a mail catcher and a webhook catcher on 127.0.0.1.</p>
          <pre><code>make stack-up
# gateway 127.0.0.1:14000 · console 127.0.0.1:18080</code></pre>
        </li>
        <li>
          <span class="step-number">02</span>
          <h3>Create the team</h3>
          <p>Sign in to the console and create the team. Set the monthly team budget, the default member budget and period, the model catalogue and the off-hours window. The reconciler applies the policy to the gateway.</p>
          <p class="muted">Working hours default to Mon–Fri 07:00–19:00, Europe/Berlin; holiday dates can be added.</p>
        </li>
        <li>
          <span class="step-number">03</span>
          <h3>Enrol the members</h3>
          <p>Create each member; the personal gateway key is shown once. Generate the managed setup bundle with the key in the environment, never on the command line.</p>
          <pre><code>TAA_MEMBER_KEY=… node src/setup/cli.ts \\
  --spec deploy/managed/example-setup.json \\
  --out /tmp/taa-bundle</code></pre>
        </li>
        <li>
          <span class="step-number">04</span>
          <h3>Lock the clients down</h3>
          <p>Install the bundle as root on the member's machine and keep the member environment file mode 0600. The installer refuses targets outside <code>/etc</code>; <code>make lockdown-check</code> proves the overrides are ignored in a disposable container.</p>
          <pre><code>sudo sh deploy/managed/install.sh /tmp/taa-bundle
make lockdown-check</code></pre>
        </li>
      </ol>
      <p class="setup-note">The managed files are the strong path, not a root-proof one. An administrator can edit them; a member who brings a personal provider key can spend outside this gateway.</p>
    </div>
  </section>

  <section class="section" id="limits" aria-labelledby="limits-title">
    <div class="wrap narrow">
      <div class="section-head">
        <p class="kicker">07 · Limits</p>
        <h2 id="limits-title">What this does not solve</h2>
      </div>
      <ul class="limits-list">
        <li><strong>Cost limits are exact; watcher caps are near-real-time.</strong><span>LiteLLM refuses before the call when a key's budget is spent. Token caps, off-hours caps and unusual-spend alerts run in the watcher, within one poll interval plus in-flight requests.</span></li>
        <li><strong>Streaming rows can undercount spend.</strong><span>In the team test ${num(data.summary.zeroCostRows)} of ${num(data.summary.totalRows)} gateway rows carried tokens with USD 0 cost. The hard limit was reached with priced metered calls, but a report built only from streaming traffic is a floor, not a bill.</span></li>
        <li><strong>A root user can edit the managed files.</strong><span>The CLI lock is a managed-configuration boundary. An administrator or root user can change it. MDM is the stronger delivery path on macOS; the Linux path is proven in a container.</span></li>
        <li><strong>A personal provider key is outside the team gate.</strong><span>If a member points a CLI at their own account, the team gateway never sees the call. The managed files and the absence of a provider key are what prevent that in normal use.</span></li>
        <li><strong>Single sign-on is not included.</strong><span>Managers sign in with a password; members use a personal gateway key. There is no SAML, OIDC or SCIM integration in v1.</span></li>
        <li><strong>Not every CLI is verified.</strong><span>Claude Code, OpenCode and Codex were tested live, and the managed pack covers them. Other MCP-capable CLIs are expected to work but are not proven.</span></li>
        <li><strong>The page's screenshots are from the demo, not a live provider.</strong><span>The request-flow strip uses the mock upstream on a fixed clock. The team-test screenshots are from the real run. Labels on each tell you which is which.</span></li>
      </ul>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <p class="brand-line">team-ai-allowance</p>
      <p class="muted">An independent portfolio project. No employer or private person is named. Demo people use invented first names.</p>
    </div>
    <div class="footer-links">
      <a href="https://github.com/sabers13/team-ai-allowance" rel="noopener">Source on GitHub <span aria-hidden="true">↗</span></a>
      <a href="#top">Back to top ↑</a>
    </div>
  </div>
  <div class="wrap footer-meta">
    <p>Evidence: <code>results/live.json</code>, <code>results/dogfood.json</code>, <code>results/dogfood-probes.json</code>, <code>results/demo/flow.json</code>, <code>results/sim/*.json</code>. Team test generated ${esc(dateTime(team.generatedAt))}.</p>
    <p>No prompt or response text is stored by the control service. This page has no network dependency except the GitHub link.</p>
  </div>
</footer>
<script>
(() => {
  const root = document.documentElement;
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const current = () => root.dataset.theme || (media.matches ? "dark" : "light");
  const paint = () => {
    const dark = current() === "dark";
    button.textContent = dark ? "Light" : "Dark";
    button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    button.setAttribute("aria-pressed", String(dark));
  };
  button.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("taa-theme", next); } catch {}
    paint();
  });
  paint();
})();
</script>
</body>
</html>
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
for (const step of data.demo.steps) {
  copyFileSync(join(root, "results/demo", step.file), join(shotsDir, step.file));
}
for (const shot of data.teamTest.shots) {
  copyFileSync(join(root, "results/dogfood", shot.file), join(shotsDir, shot.file));
  if (shot.mobileFile !== shot.file) {
    copyFileSync(join(root, "results/dogfood", shot.mobileFile), join(shotsDir, shot.mobileFile));
  }
}
writeFileSync(join(outDir, "index.html"), html);

const size = statSync(join(outDir, "index.html")).size;
process.stdout.write(
  `page: dist/team-ai-allowance/index.html (${num(size)} bytes, ${data.demo.steps.length + data.teamTest.shots.length * 2} images)\n`,
);
