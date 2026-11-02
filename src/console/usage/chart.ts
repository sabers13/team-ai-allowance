/**
 * The stacked daily cost chart. Hand-built inline SVG, no chart library.
 *
 * Bars are stacked by member or by model. Each series carries a colour token
 * and, from the second series on, a hatch pattern, so a greyscale print still
 * separates the stacks. The same numbers live in a visually hidden table.
 */

import { shortDate, usd } from "../format.ts";
import { type Html, html, raw } from "../html.ts";
import type { UsageReport, UsageSeriesRow } from "./report.ts";

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 36, left: 68 };

const FILL: Readonly<Record<UsageSeriesRow["tone"], string>> = {
  accent: "var(--accent)",
  ok: "var(--ok-text)",
  soft: "var(--soft-text)",
  grace: "var(--grace-text)",
  blocked: "var(--blocked-text)",
  muted: "var(--text-faint)",
};

const HATCHES = ["", "M0 6 L6 0", "M0 3 H6", "M3 0 V6", "M0 0 L6 6 M6 0 L0 6", "M0 2 H6 M0 5 H6"];

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * base;
}

function axisLabel(value: number): string {
  return usd(value);
}

function titleId(report: UsageReport): string {
  return `usage-chart-${report.series}`;
}

function patternDefs(series: readonly UsageSeriesRow[]): Html {
  const defs = series.map((row, index) => {
    if (index === 0) return html``;
    const hatch = HATCHES[index % HATCHES.length] ?? "";
    return html`<pattern id="usage-stack-${index}" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="${FILL[row.tone]}"></rect>
      <path d="${hatch}" stroke="var(--surface)" stroke-width="1.2" opacity="0.65"></path>
    </pattern>`;
  });
  return html`<defs>${defs}</defs>`;
}

function fillOf(row: UsageSeriesRow, index: number): string {
  return index === 0 ? FILL[row.tone] : `url(#usage-stack-${index})`;
}

export function stackedUsageChart(report: UsageReport, timeZone: string): Html {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const totals = report.days.map((_, index) =>
    report.seriesRows.reduce((sum, row) => sum + (row.values[index] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const slot = plotWidth / Math.max(1, report.days.length);
  const barWidth = Math.max(2, Math.min(36, slot * 0.64));

  const bars: string[] = [];
  for (let index = 0; index < report.days.length; index += 1) {
    const x = PAD.left + index * slot + (slot - barWidth) / 2;
    let y = PAD.top + plotHeight;
    for (let seriesIndex = report.seriesRows.length - 1; seriesIndex >= 0; seriesIndex -= 1) {
      const row = report.seriesRows[seriesIndex];
      if (row === undefined) continue;
      const value = row.values[index] ?? 0;
      if (value <= 0) continue;
      const barHeight = (value / max) * plotHeight;
      y -= barHeight;
      bars.push(
        `<rect class="chart__bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${fillOf(row, seriesIndex)}"><title>${shortDate(
          `${report.days[index] ?? ""}T12:00:00Z`,
          timeZone,
        )} · ${row.label}: ${usd(value)}</title></rect>`,
      );
    }
  }

  const grid = [0, 0.5, 1]
    .map((fraction) => {
      const value = max * fraction;
      const y = PAD.top + plotHeight - fraction * plotHeight;
      return html`<line class="chart__grid" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${WIDTH - PAD.right}" y2="${y.toFixed(1)}"></line>
        <text class="chart__axis-label" x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${axisLabel(value)}</text>`;
    })
    .join("");

  const step = Math.max(1, Math.ceil(report.days.length / 8));
  const labels = report.days
    .map((day, index) =>
      index % step === 0 || index === report.days.length - 1
        ? html`<text class="chart__axis-label" x="${(PAD.left + index * slot + slot / 2).toFixed(1)}" y="${HEIGHT - 12}" text-anchor="middle">${shortDate(
            `${day}T12:00:00Z`,
            timeZone,
          )}</text>`
        : "",
    )
    .join("");

  const legend = report.seriesRows.map(
    (row, index) => html`<li class="chart__legend-item">
      <span class="chart__swatch chart__swatch--block chart__swatch--${row.tone}" aria-hidden="true"></span>
      ${row.label} <span class="faint">${usd(row.costUsd)}</span>${index === 0 ? "" : html`<span class="visually-hidden"> (hatched)</span>`}
    </li>`,
  );

  const header = html`<tr>
    <th scope="col">Day</th>
    ${report.seriesRows.map((row) => html`<th scope="col" class="numeric">${row.label}</th>`)}
    <th scope="col" class="numeric">Total</th>
  </tr>`;
  const body = report.days.map(
    (day, index) => html`<tr>
      <th scope="row">${day}</th>
      ${report.seriesRows.map(
        (row) => html`<td class="numeric">${usd(row.values[index] ?? 0)}</td>`,
      )}
      <td class="numeric">${usd(totals[index] ?? 0)}</td>
    </tr>`,
  );

  const id = titleId(report);
  const title = `Daily cost, stacked by ${report.series}`;
  return html`<div class="chart usage-chart" tabindex="0" role="group" aria-label="Daily cost chart">
    <ul class="chart__legend" aria-label="Chart series">${legend}</ul>
    <svg class="chart__svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="${id}-title ${id}-desc" preserveAspectRatio="xMidYMid meet">
      <title id="${id}-title">${title}</title>
      <desc id="${id}-desc">Daily cost from ${report.period.fromDate} to ${report.period.toDate}, stacked by ${report.series}.</desc>
      ${patternDefs(report.seriesRows)}
      ${raw(grid)}
      ${raw(bars.join(""))}
      ${labels}
    </svg>
    <div class="visually-hidden">
      <table>
        <caption>${title}. Daily cost in US dollars from ${report.period.fromDate} to ${report.period.toDate}.</caption>
        <thead>${header}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}
