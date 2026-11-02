import assert from "node:assert/strict";
import { test } from "node:test";
import { lineChart } from "../../src/console/chart.ts";

test("a chart draws a line per series and keeps the numbers in a hidden table", () => {
  const chart = lineChart({
    title: "Daily spend",
    description: "Two models",
    labels: ["1 Oct", "2 Oct", "3 Oct"],
    series: [
      { id: "a", label: "Model A", tone: "accent", dash: "", values: [1, 2, 3] },
      { id: "b", label: "Model B", tone: "ok", dash: "4 4", values: [0.5, 1, 1.5] },
    ],
    formatValue: (value) => `USD ${value.toFixed(2)}`,
  }).value;

  assert.equal((chart.match(/<polyline/g) ?? []).length, 2);
  assert.equal(chart.includes('stroke-dasharray="4 4"'), true);
  assert.equal(chart.includes("visually-hidden"), true);
  assert.equal(chart.includes("USD 3.00"), true);
  assert.equal(chart.includes("<title id="), true);
  assert.equal(chart.includes("Model B"), true);
});

test("money axis labels are USD values, not raw floats", () => {
  const chart = lineChart({
    title: "Spend",
    description: "one series",
    labels: ["1 Oct", "2 Oct"],
    series: [{ id: "a", label: "A", tone: "accent", dash: "", values: [0, 5] }],
    formatValue: (value) => `USD ${value.toFixed(0)}`,
  }).value;
  assert.equal(chart.includes("USD 0"), true);
  assert.equal(chart.includes("USD 5"), true);
});

test("an empty series still renders a valid chart frame", () => {
  const chart = lineChart({
    title: "Nothing",
    description: "no rows",
    labels: [],
    series: [],
    formatValue: (value) => String(value),
  }).value;
  assert.equal(chart.includes("<svg"), true);
  assert.equal(chart.includes("visually-hidden"), true);
});

test("a title with markup is escaped", () => {
  const chart = lineChart({
    title: '<img src=x onerror="alert(1)">',
    description: "",
    labels: ["a"],
    series: [],
    formatValue: (value) => String(value),
  }).value;
  assert.equal(chart.includes("<img src=x"), false);
  assert.equal(chart.includes("&lt;img"), true);
});
