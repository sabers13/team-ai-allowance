import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUsageReport,
  inferCli,
  summarizeCli,
  type UsageMember,
  type UsageQuery,
  usageCsv,
  usageFileName,
  usagePeriod,
} from "../../src/console/usage/index.ts";
import type { ModelEntry, UsageRow } from "../../src/contracts.ts";

const NOW = new Date("2026-10-31T18:00:00Z");
const TZ = "Europe/Berlin";

const MEMBERS: UsageMember[] = [
  { id: "mem_a", displayName: "Lena", status: "soft", limitUsd: 20 },
  { id: "mem_b", displayName: "Omar", status: "ok", limitUsd: 40 },
];

const MODELS: ModelEntry[] = [
  {
    id: "model-one",
    displayName: "Model One",
    route: "mock/model-one",
    inputPer1MUsd: 1,
    outputPer1MUsd: 2,
    state: "enabled",
    sortOrder: 1,
  },
  {
    id: "model-two",
    displayName: "Model Two",
    route: "mock/model-two",
    inputPer1MUsd: 2,
    outputPer1MUsd: 4,
    state: "enabled",
    sortOrder: 2,
  },
];

function row(overrides: Partial<UsageRow>): UsageRow {
  return {
    id: "use_1",
    memberId: "mem_a",
    modelId: "model-one",
    at: "2026-10-31T08:00:00Z",
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 1,
    requestId: null,
    apiFormat: "anthropic_messages",
    ...overrides,
  };
}

const ROWS: UsageRow[] = [
  row({ id: "u1", costUsd: 1 }),
  row({ id: "u2", costUsd: 2, at: "2026-10-31T09:00:00Z", apiFormat: "responses" }),
  row({
    id: "u3",
    modelId: "model-two",
    costUsd: 0.5,
    inputTokens: 300,
    outputTokens: 30,
    at: "2026-10-31T10:00:00Z",
    apiFormat: "chat_completions",
  }),
  row({
    id: "u4",
    memberId: "mem_b",
    costUsd: 3,
    inputTokens: 400,
    outputTokens: 40,
    at: "2026-10-30T08:00:00Z",
  }),
  row({ id: "u5", memberId: "mem_other", costUsd: 100 }),
  row({ id: "u6", costUsd: 99, at: "2026-11-05T08:00:00Z" }),
  row({ id: "u7", costUsd: 50, at: "2026-09-01T08:00:00Z" }),
];

function query(overrides: Partial<UsageQuery> = {}): UsageQuery {
  return {
    period: "30",
    from: null,
    to: null,
    series: null,
    sort: null,
    dir: null,
    ...overrides,
  };
}

function report(overrides: Partial<UsageQuery> = {}) {
  return buildUsageReport({
    query: query(overrides),
    now: NOW,
    timeZone: TZ,
    scopeLabel: "Platform team",
    members: MEMBERS,
    models: MODELS,
    usage: ROWS,
  });
}

test("today starts at local midnight, not UTC midnight", () => {
  const period = usagePeriod(new URLSearchParams({ period: "today" }), NOW, TZ);
  assert.equal(period.key, "today");
  assert.equal(period.fromDate, "2026-10-31");
  assert.equal(period.toDate, "2026-10-31");
  assert.equal(period.days.length, 1);
  assert.equal(period.from.toISOString(), "2026-10-30T23:00:00.000Z");
});

test("a custom period covers whole local days and reports its own label", () => {
  const period = usagePeriod(
    new URLSearchParams({ from: "2026-10-01", to: "2026-10-03" }),
    NOW,
    TZ,
  );
  assert.equal(period.key, "custom");
  assert.equal(period.label, "2026-10-01 to 2026-10-03");
  assert.deepEqual(period.days, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(period.from.toISOString(), "2026-09-30T22:00:00.000Z");
  assert.equal(period.to.toISOString(), "2026-10-03T21:59:59.999Z");
});

test("an invalid custom range falls back to the 30-day preset", () => {
  const period = usagePeriod(
    new URLSearchParams({ from: "2026-10-10", to: "2026-10-01" }),
    NOW,
    TZ,
  );
  assert.equal(period.key, "30");
  assert.equal(period.days.length, 30);
});

test("aggregates requests, tokens, cost, limit share, top model and the inferred CLI", () => {
  const result = report();
  assert.equal(result.rows.length, 2);
  const lena = result.rows.find((entry) => entry.memberId === "mem_a");
  assert.ok(lena !== undefined);
  assert.equal(lena.requests, 3);
  assert.equal(lena.inputTokens, 500);
  assert.equal(lena.outputTokens, 50);
  assert.equal(lena.costUsd, 3.5);
  assert.equal(lena.percentOfLimit, 18);
  assert.equal(lena.topModel, "Model One");
  assert.equal(lena.topModelId, "model-one");
  assert.equal(lena.cli.cli.label, "Claude Code");
  assert.equal(lena.cli.requests, 1);
  assert.equal(lena.cli.mixed, true);
});

test("scoping ignores rows for members outside the team and outside the period", () => {
  const result = report();
  assert.equal(result.totalRequests, 4);
  assert.equal(result.totalCostUsd, 6.5);
  assert.equal(result.totalInputTokens, 900);
  assert.equal(result.totalOutputTokens, 90);
  assert.equal(
    result.rows.some((entry) => entry.memberId === "mem_other"),
    false,
  );
});

test("rows sort by every column, including percent of limit", () => {
  const byName = report({ sort: "name", dir: "asc" });
  assert.deepEqual(
    byName.rows.map((entry) => entry.displayName),
    ["Lena", "Omar"],
  );
  const byPercent = report({ sort: "percent", dir: "desc" });
  assert.deepEqual(
    byPercent.rows.map((entry) => entry.memberId),
    ["mem_a", "mem_b"],
  );
  const byCostAsc = report({ sort: "cost", dir: "asc" });
  assert.deepEqual(
    byCostAsc.rows.map((entry) => entry.memberId),
    ["mem_b", "mem_a"],
  );
  const byStatus = report({ sort: "status", dir: "asc" });
  assert.deepEqual(
    byStatus.rows.map((entry) => entry.memberId),
    ["mem_b", "mem_a"],
  );
});

test("the chart stacks daily cost by member or by model", () => {
  const byMember = report({ series: "member" });
  assert.deepEqual(
    byMember.seriesRows.map((entry) => entry.label),
    ["Lena", "Omar"],
  );
  const lena = byMember.seriesRows.find((entry) => entry.key === "mem_a");
  assert.ok(lena !== undefined);
  assert.equal(
    lena.values.reduce((sum, value) => sum + value, 0),
    3.5,
  );
  assert.equal(byMember.days.length, 30);

  const byModel = report({ series: "model" });
  assert.deepEqual(
    byModel.seriesRows.map((entry) => entry.label),
    ["Model One", "Model Two"],
  );
});

test("CSV has one row per member, quoted names and the inferred CLI columns", () => {
  const result = buildUsageReport({
    query: query(),
    now: NOW,
    timeZone: TZ,
    scopeLabel: "Platform team",
    members: [{ id: "mem_a", displayName: 'Lena, "A"', status: "soft", limitUsd: 20 }],
    models: MODELS,
    usage: ROWS,
  });
  const csv = usageCsv(result);
  const lines = csv.trimEnd().split("\n");
  assert.equal(
    lines[0],
    "member,member_id,status,requests,input_tokens,output_tokens,cost_usd,limit_usd,percent_of_limit,top_model,cli,cli_inferred,api_format",
  );
  assert.match(
    lines[1] ?? "",
    /^"Lena, ""A""",mem_a,soft,3,500,50,3\.500000,20\.00,18,Model One,Claude Code,true,/,
  );
  assert.equal(usageFileName(result), "usage-2026-10-02-to-2026-10-31.csv");
});

test("every API format maps to one CLI and every label says it is inferred", () => {
  assert.deepEqual(inferCli("anthropic_messages"), {
    id: "claude-code",
    label: "Claude Code",
    apiFormat: "anthropic_messages",
  });
  assert.equal(inferCli("responses").label, "OpenCode");
  assert.equal(inferCli("chat_completions").label, "Codex");
  assert.equal(inferCli("unknown").label, "Unknown");
  assert.equal(inferCli(undefined).label, "Unknown");
  assert.deepEqual(summarizeCli([]), {
    cli: { id: "unknown", label: "Unknown", apiFormat: "unknown" },
    requests: 0,
    mixed: false,
  });

  const mixed = summarizeCli([
    row({ id: "m1", apiFormat: "chat_completions" }),
    row({ id: "m2", apiFormat: "chat_completions" }),
    row({ id: "m3", apiFormat: "anthropic_messages" }),
  ]);
  assert.equal(mixed.cli.label, "Codex");
  assert.equal(mixed.requests, 2);
  assert.equal(mixed.mixed, true);
});
