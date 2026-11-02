/**
 * The usage chart: hand-built inline SVG, no chart library.
 *
 * Renders three grid lines, a solid current line and a dashed
 * comparison line, money labels written as `USD 5`, no load animation, and the
 * same numbers in a visually hidden table for screen readers. The series carry
 * a dash pattern as well as a colour so they still read in greyscale.
 */

import { type Html, html, raw } from "./html.ts";

export interface ChartSeries {
  id: string;
  label: string;
  tone: "accent" | "ok" | "soft" | "grace" | "blocked" | "muted";
  dash: string;
  values: number[];
}

export interface LineChartOptions {
  title: string;
  description: string;
  labels: string[];
  series: ChartSeries[];
  formatValue: (value: number) => string;
  width?: number;
  height?: number;
}

const PADDING = { top: 16, right: 16, bottom: 34, left: 64 };

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * base;
}

function axisLabel(value: number, formatValue: (value: number) => string): string {
  if (Number.isInteger(value)) return formatValue(value);
  return value.toFixed(2);
}

export function lineChart(options: LineChartOptions): Html {
  const width = options.width ?? 720;
  const height = options.height ?? 220;
  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;
  const pointCount = Math.max(1, options.labels.length);
  const max = niceMax(Math.max(0, ...options.series.flatMap((series) => series.values)));

  const xAt = (index: number): number =>
    options.labels.length <= 1
      ? PADDING.left
      : PADDING.left + (index / (pointCount - 1)) * plotWidth;
  const yAt = (value: number): number =>
    PADDING.top + plotHeight * (1 - Math.max(0, Math.min(1, value / max)));

  const gridValues = [0, max / 2, max];
  const grid = gridValues.map(
    (
      value,
    ) => html`<line class="chart__grid" x1="${PADDING.left}" x2="${width - PADDING.right}" y1="${yAt(value).toFixed(1)}" y2="${yAt(value).toFixed(1)}"></line>
      <text class="chart__axis-label" x="${PADDING.left - 8}" y="${(yAt(value) + 4).toFixed(1)}" text-anchor="end">${axisLabel(value, options.formatValue)}</text>`,
  );

  const tickIndexes = new Set<number>();
  const step = Math.max(1, Math.ceil((pointCount - 1) / 4));
  for (let index = 0; index < pointCount; index += step) tickIndexes.add(index);
  tickIndexes.add(pointCount - 1);
  const xTicks = [...tickIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const anchor = index === 0 ? "start" : index === pointCount - 1 ? "end" : "middle";
      return html`<text class="chart__axis-label" x="${xAt(index).toFixed(1)}" y="${height - 12}" text-anchor="${anchor}">${options.labels[index] ?? ""}</text>`;
    });

  const lines = options.series.map((series) => {
    const points = series.values
      .map((value, index) => `${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`)
      .join(" ");
    const markers = series.values
      .map((value, index) => {
        const focusable = index % step === 0 || index === pointCount - 1;
        const label = `${options.labels[index] ?? ""}: ${series.label} ${options.formatValue(value)}`;
        return html`<circle class="chart__point chart__point--${series.tone}" cx="${xAt(index).toFixed(1)}" cy="${yAt(value).toFixed(1)}" r="2.6"${focusable ? raw(' tabindex="0" role="img"') : ""} aria-label="${label}"><title>${label}</title></circle>`;
      })
      .join("");
    return html`<g class="chart__series chart__series--${series.tone}">
      <polyline class="chart__line chart__line--${series.tone}" points="${points}" fill="none" stroke-width="1.5"${series.dash === "" ? "" : raw(` stroke-dasharray="${series.dash}"`)}></polyline>
      ${markers}
    </g>`;
  });

  const legend = options.series.map(
    (series) => html`<li class="chart__legend-item">
      <span class="chart__swatch chart__swatch--${series.tone}${series.dash === "" ? "" : " chart__swatch--dash"}" aria-hidden="true"></span>${series.label}
    </li>`,
  );

  const header = html`<tr>
    <th scope="col">Day</th>
    ${options.series.map((series) => html`<th scope="col" class="numeric">${series.label}</th>`)}
  </tr>`;
  const body = options.labels.map(
    (label, index) => html`<tr>
      <th scope="row">${label}</th>
      ${options.series.map(
        (series) =>
          html`<td class="numeric">${options.formatValue(series.values[index] ?? 0)}</td>`,
      )}
    </tr>`,
  );

  return html`<div class="chart">
    <ul class="chart__legend" aria-label="Chart series">${legend}</ul>
    <svg class="chart__svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${options.title.replaceAll(/\W+/g, "-")}-title" preserveAspectRatio="xMidYMid meet">
      <title id="${options.title.replaceAll(/\W+/g, "-")}-title">${options.title}</title>
      <desc>${options.description}</desc>
      ${grid}
      ${xTicks}
      ${lines}
    </svg>
    <div class="visually-hidden">
      <table>
        <caption>${options.title}. ${options.description}</caption>
        <thead>${header}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}
