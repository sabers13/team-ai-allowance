/**
 * Page data for `dist/team-ai-allowance/index.html`.
 *
 * Every number the page prints is assembled here from committed files under
 * `results/`. Nothing is typed into the template: a missing or contradictory
 * source makes `make page` fail instead of publishing a guess.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PageFact {
  id: string;
  display: string;
  value: string | number;
  source: string;
  basis: "literal" | "derived";
  note?: string;
}

export interface LiveStep {
  key: string;
  label: string;
  pass: boolean;
  status: number | null;
  detail: string;
}

export interface LiveCli {
  cli: string;
  version: string;
  available: boolean;
  steps: LiveStep[];
}

export interface DemoStep {
  step: number;
  name: string;
  observed: string;
  file: string;
  width: number;
  height: number;
}

export interface SimPoint {
  t: string;
  spendUsd: number;
}

export interface SimScenario {
  scenario: string;
  title: string;
  points: SimPoint[];
  stop: {
    t: string;
    step: number;
    reason: string;
    spendUsd: number;
    detail: string;
  };
  totals: { steps: number; spendUsd: number };
  assumptions: string[];
  parameters: {
    weekendStart: string;
    weekendEnd: string;
    timeZone: string;
    budgetUsd: number | null;
    hardLimitUsd: number | null;
    offHoursCapUsd: number | null;
  };
}

export interface TeamScenario {
  id: string;
  title: string;
  member: string;
  team: string;
  pass: boolean;
  partial: boolean;
  spendUsd: number;
  expected: Array<{ event: string; happened: boolean; at: string | null; evidence: string }>;
  notes: string[];
}

export interface Decision {
  requestId: string;
  at: string;
  memberName: string;
  outcome: string;
  note: string;
  decidedBy: string;
  minutesToDecision: number | null;
  filedAt: string;
  kind: string;
  detail: string;
}

export interface Probe {
  id: string;
  title: string;
  expected: string;
  observed: string;
  pass: boolean;
  costUsd: number;
  failedChecks: string[];
}

export interface TeamShot {
  label: string;
  file: string;
  mobileFile: string;
  caption: string;
}

export interface PageData {
  meta: {
    generatedAt: string;
    sources: string[];
    demoClock: string;
    demoGeneratedBy: string;
  };
  summary: {
    clisVerified: number;
    liveStepsPassed: number;
    liveStepsTotal: number;
    probesPassed: number;
    probesTotal: number;
    teamSpendUsd: number;
    unconstrainedSimulationUsd: number;
    zeroCostRows: number;
    totalRows: number;
    zeroCostTokens: number;
  };
  live: {
    runAt: string;
    totalSpendUsd: number;
    upstreamStopTripped: boolean;
    clis: LiveCli[];
    plugin: { pass: boolean; message: string; spendUsd: number };
  };
  demo: { clock: string; steps: DemoStep[] };
  simulation: {
    label: string;
    weekendStart: string;
    weekendEnd: string;
    scenarios: SimScenario[];
  };
  teamTest: {
    generatedAt: string;
    window: { from: string; to: string };
    teams: Array<{
      name: string;
      members: number;
      requests: number;
      auditEvents: number;
      usageRows: number;
    }>;
    scenarioSummary: TeamScenario[];
    decisions: Decision[];
    probes: Probe[];
    probesPassed: number;
    probesTotal: number;
    probeCostUsd: number;
    whatWentWrong: Array<{ summary: string; detail: string }>;
    spend: {
      totalUsd: number;
      rows: number;
      zeroCostRows: number;
      zeroCostTokens: number;
      byMember: Array<{ name: string; spendUsd: number; rows: number }>;
    };
    shots: TeamShot[];
    counts: {
      requestCreatedNotifications: number;
      requestDecidedNotifications: number;
      unusualSpendNotifications: number;
      hardLimitNotifications: number;
      mailMessages: number;
      webhookEvents: number;
    };
  };
  facts: PageFact[];
}

interface RawLive {
  runAt: string;
  upstreamStopTripped: boolean;
  totalSpendUsd: number;
  clis: Array<{
    cli: string;
    version: string;
    available: boolean;
    steps: Array<{ key: string; pass: boolean; status: number | null; message: string }>;
  }>;
  plugin: { pass: boolean; message: string; spendUsd: number };
  approvals: Array<{ amountUsd: number }>;
}

interface RawFlow {
  generatedBy: string;
  clock: string;
  steps: Array<{ step: number; name: string; screenshot: string; observed: string }>;
}

interface RawSim {
  label: string;
  scenario: string;
  title: string;
  assumptions: string[];
  parameters: {
    weekendStart: string;
    weekendEnd: string;
    timeZone: string;
    budgetUsd: number | null;
    hardLimitUsd: number | null;
    offHoursCapUsd: number | null;
  };
  series: Array<{ t: string; spendUsd: number }>;
  stop: { t: string; step: number; reason: string; spendUsd: number; detail: string };
  totals: { steps: number; spendUsd: number };
}

interface RawDogfood {
  generatedAt: string;
  testWindow: { from: string; to: string };
  teams: Array<{
    name: string;
    members: number;
    requests: number;
    auditEvents: number;
    usageRows: number;
  }>;
  scenarios: Array<{
    id: string;
    title: string;
    member: { displayName: string; team: string };
    pass: boolean;
    partial: boolean;
    expected: Array<{ event: string; happened: "yes" | "no"; at: string | null; evidence: string }>;
    spendUsd: number;
    requests: Array<{
      id: string;
      kind: string;
      amountUsd: number | null;
      modelId: string | null;
    }>;
    notes: string[];
  }>;
  decisions: Array<{
    requestId: string;
    at: string;
    memberName: string;
    outcome: string;
    note: string;
    decidedBy: string;
    minutesToDecision: number | null;
    filedAt: string;
  }>;
  spend: {
    totalUsd: number;
    rows: number;
    zeroCostRows: number;
    zeroCostTokens: number;
    byMember: Array<{ displayName: string | null; spendUsd: number; rows: number }>;
  };
  crossCutting: {
    requestCreatedNotifications: number;
    requestDecidedNotifications: number;
    unusualSpendNotifications: number;
    hardLimitNotifications: number;
    mailMessages: number;
    webhookEvents: number;
  };
  whatWentWrong: Array<{ summary: string; detail: string }>;
}

interface RawProbes {
  probes: Array<{
    id: string;
    title: string;
    expected: string;
    observed: string;
    pass: boolean;
    costUsd: number;
    checks: Array<{ name: string; observed: string; pass: boolean }>;
  }>;
  totals: { probes: number; passed: number; failed: number; costUsd: number };
}

const LIVE_LABELS: Record<string, string> = {
  "allowed-answers": "Allowed model answers",
  "blocked-refused": "Blocked model refused",
  "budget-exhausted": "Budget exhausted",
  "mcp-request": "MCP request filed",
  "manager-approval": "Manager approves",
  "works-again": "Works again",
};

const DEMO_FILES = [
  "step-01-lena-works.png",
  "step-02-lena-soft.png",
  "step-03-lena-hard.png",
  "step-04-lena-request.png",
  "step-05-priya-partly.png",
  "step-06-lena-continues.png",
  "step-07-omar-denied.png",
  "step-08-jonas-offhours.png",
  "step-08b-jonas-unblocked.png",
  "step-09-audit.png",
  "step-10-usage.png",
];

const TEAM_SHOTS: Array<Omit<TeamShot, "mobileFile"> & { mobileFile?: string }> = [
  {
    label: "Overview after the test",
    file: "overview-crew-1280-light.png",
    mobileFile: "overview-crew-360-light.png",
    caption:
      "Crew spend and the members' final state. The extra Console row is the temporary login used to take these screenshots.",
  },
  {
    label: "Requests history",
    file: "requests-history-crew-1280-light.png",
    mobileFile: "requests-history-crew-360-light.png",
    caption: "Every request the leader decided, with the outcome and the note the member saw.",
  },
  {
    label: "A blocked member",
    file: "member-m1-crew-1280-light.png",
    mobileFile: "member-m1-crew-360-light.png",
    caption:
      "Mira at the hard stop. The policy badge says Blocked while the Key card still says Active: one of the defects below.",
  },
  {
    label: "Audit log",
    file: "audit-crew-1280-light.png",
    mobileFile: "audit-crew-360-light.png",
    caption:
      "The Crew audit, filtered to the test window. Requests, decisions, limits and key state are appended.",
  },
];

function readJson<T>(root: string, relative: string): T {
  const path = join(root, relative);
  if (!existsSync(path)) throw new Error(`page: missing source ${relative}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readSource(root: string, relative: string): string {
  const path = join(root, relative);
  if (!existsSync(path)) throw new Error(`page: missing source ${relative}`);
  return readFileSync(path, "utf8");
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`page: not a PNG: ${path}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function httpCode(status: number | null, message: string): string {
  if (status !== null && status >= 400) return `HTTP ${status}`;
  const match = message.match(/\b(401|403|422)\b/);
  if (match?.[1] !== undefined) return `HTTP ${match[1]}`;
  if (status === 0 || status === 1) return `exit ${status}`;
  return "";
}

function liveDetail(
  key: string,
  status: number | null,
  message: string,
  pass: boolean,
  approvalUsd: number | null,
): string {
  const code = httpCode(status, message);
  switch (key) {
    case "allowed-answers":
      return pass ? "HTTP 200 · answered" : "the allowed model did not answer";
    case "blocked-refused":
      return `${code === "" ? "" : `${code} · `}model not available for this key`;
    case "budget-exhausted":
      return `${code === "" ? "" : `${code} · `}budget or key stopped the call`;
    case "mcp-request":
      return "request created through the MCP desk";
    case "manager-approval":
      return approvalUsd === null ? "approved" : `approved · USD ${approvalUsd.toFixed(2)} grant`;
    case "works-again":
      return "HTTP 200 · answered after the approval";
    default:
      return pass ? "passed" : "failed";
  }
}

function teamShotList(root: string): TeamShot[] {
  return TEAM_SHOTS.map((shot) => {
    const mobile = shot.mobileFile ?? shot.file;
    const base = join(root, "results/dogfood");
    if (!existsSync(join(base, shot.file)))
      throw new Error(`page: missing screenshot ${shot.file}`);
    if (!existsSync(join(base, mobile))) throw new Error(`page: missing screenshot ${mobile}`);
    return { ...shot, mobileFile: mobile };
  });
}

export function buildPageData(root: string): PageData {
  const liveRaw = readJson<RawLive>(root, "results/live.json");
  const flow = readJson<RawFlow>(root, "results/demo/flow.json");
  const dogfood = readJson<RawDogfood>(root, "results/dogfood.json");
  const probesRaw = readJson<RawProbes>(root, "results/dogfood-probes.json");
  const simNames = ["no-limits", "budget-only", "off-hours-only", "all-limits"];
  const sims = simNames.map((name) => readJson<RawSim>(root, `results/sim/${name}.json`));
  const simLabel = sims[0]?.label ?? "";
  if (sims.some((sim) => sim.label !== "simulation")) {
    throw new Error("page: every simulation file must carry label=simulation");
  }

  const sources = [
    "results/live.json",
    "results/dogfood.json",
    "results/dogfood-probes.json",
    "results/demo/flow.json",
    ...simNames.map((name) => `results/sim/${name}.json`),
  ];

  const demoSteps: DemoStep[] = flow.steps.map((step, index) => {
    const file = step.screenshot.replace(/^results\/demo\//, "");
    const expected = DEMO_FILES[index];
    if (expected !== undefined && expected !== file) {
      throw new Error(`page: demo step ${step.step} points at ${file}, expected ${expected}`);
    }
    const path = join(root, step.screenshot);
    if (!existsSync(path)) throw new Error(`page: missing demo screenshot ${step.screenshot}`);
    const size = pngSize(path);
    return {
      step: step.step,
      name: step.name,
      observed: step.observed,
      file,
      width: size.width,
      height: size.height,
    };
  });

  const clis: LiveCli[] = liveRaw.clis
    .filter((cli) => cli.cli !== "opencode-plugin")
    .map((cli) => ({
      cli: cli.cli,
      version: cli.version,
      available: cli.available,
      steps: cli.steps.map((step) => ({
        key: step.key,
        label: LIVE_LABELS[step.key] ?? step.key,
        pass: step.pass,
        status: step.status,
        detail: liveDetail(
          step.key,
          step.status,
          step.message,
          step.pass,
          liveRaw.approvals[0]?.amountUsd ?? null,
        ),
      })),
    }));

  const liveStepsTotal = clis.reduce((sum, cli) => sum + cli.steps.length, 0);
  const liveStepsPassed = clis.reduce(
    (sum, cli) => sum + cli.steps.filter((step) => step.pass).length,
    0,
  );

  const decisions: Decision[] = dogfood.decisions.map((decision) => {
    let match: RawDogfood["scenarios"][number] | undefined;
    let requestKind = "";
    let requestDetail = "";
    for (const scenario of dogfood.scenarios) {
      const request = scenario.requests.find((item) => item.id === decision.requestId);
      if (request !== undefined) {
        match = scenario;
        requestKind = request.kind === "model_unlock" ? "Model unlock" : "More budget";
        requestDetail =
          request.amountUsd === null
            ? (request.modelId ?? "")
            : `USD ${request.amountUsd.toFixed(2)}`;
        break;
      }
    }
    return {
      requestId: decision.requestId,
      at: decision.at,
      memberName: decision.memberName,
      outcome: decision.outcome,
      note: decision.note,
      decidedBy: decision.decidedBy,
      minutesToDecision: decision.minutesToDecision,
      filedAt: decision.filedAt,
      kind: requestKind !== "" ? requestKind : (match?.title ?? "Request"),
      detail: requestDetail,
    };
  });

  const probes: Probe[] = probesRaw.probes.map((probe) => ({
    id: probe.id,
    title: probe.title,
    expected: probe.expected,
    observed: probe.observed,
    pass: probe.pass,
    costUsd: probe.costUsd,
    failedChecks: probe.checks
      .filter((check) => !check.pass)
      .map((check) => `${check.name}: ${check.observed}`),
  }));

  const scenarios: TeamScenario[] = dogfood.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    member: scenario.member.displayName,
    team: scenario.member.team,
    pass: scenario.pass,
    partial: scenario.partial,
    spendUsd: scenario.spendUsd,
    expected: scenario.expected.map((event) => ({
      event: event.event,
      happened: event.happened === "yes",
      at: event.at,
      evidence: event.evidence,
    })),
    notes: scenario.notes,
  }));

  const teamTest: PageData["teamTest"] = {
    generatedAt: dogfood.generatedAt,
    window: dogfood.testWindow,
    teams: dogfood.teams.map((team) => ({
      name: team.name,
      members: team.members,
      requests: team.requests,
      auditEvents: team.auditEvents,
      usageRows: team.usageRows,
    })),
    scenarioSummary: scenarios,
    decisions,
    probes,
    probesPassed: probesRaw.totals.passed,
    probesTotal: probesRaw.totals.probes,
    probeCostUsd: probesRaw.totals.costUsd,
    whatWentWrong: dogfood.whatWentWrong,
    spend: {
      totalUsd: dogfood.spend.totalUsd,
      rows: dogfood.spend.rows,
      zeroCostRows: dogfood.spend.zeroCostRows,
      zeroCostTokens: dogfood.spend.zeroCostTokens,
      byMember: dogfood.spend.byMember
        .filter((member) => member.displayName !== null)
        .map((member) => ({
          name: member.displayName ?? "unknown",
          spendUsd: member.spendUsd,
          rows: member.rows,
        }))
        .sort((a, b) => b.spendUsd - a.spendUsd || b.rows - a.rows),
    },
    shots: teamShotList(root),
    counts: dogfood.crossCutting,
  };

  const simulation: PageData["simulation"] = {
    label: simLabel,
    weekendStart: sims[0]?.parameters.weekendStart ?? "",
    weekendEnd: sims[0]?.parameters.weekendEnd ?? "",
    scenarios: sims.map((sim) => ({
      scenario: sim.scenario,
      title: sim.title,
      points: sim.series.map((point) => ({ t: point.t, spendUsd: point.spendUsd })),
      stop: {
        t: sim.stop.t,
        step: sim.stop.step,
        reason: sim.stop.reason,
        spendUsd: sim.stop.spendUsd,
        detail: sim.stop.detail,
      },
      totals: { steps: sim.totals.steps, spendUsd: sim.totals.spendUsd },
      assumptions: sim.assumptions,
      parameters: {
        weekendStart: sim.parameters.weekendStart,
        weekendEnd: sim.parameters.weekendEnd,
        timeZone: sim.parameters.timeZone,
        budgetUsd: sim.parameters.budgetUsd,
        hardLimitUsd: sim.parameters.hardLimitUsd,
        offHoursCapUsd: sim.parameters.offHoursCapUsd,
      },
    })),
  };

  const noLimits = simulation.scenarios.find((sim) => sim.scenario === "no-limits");
  if (noLimits === undefined) throw new Error("page: the no-limits simulation is missing");

  const clisVerified = clis.filter(
    (cli) => cli.available && cli.steps.every((step) => step.pass),
  ).length;

  const facts: PageFact[] = [
    fact(
      "clis-verified",
      `${clisVerified}`,
      clisVerified,
      "results/live.json",
      "derived",
      "CLIs with every step passing",
    ),
    fact(
      "live-steps",
      `${liveStepsPassed}/${liveStepsTotal}`,
      liveStepsPassed,
      "results/live.json",
      "derived",
      "passing live steps",
    ),
    fact(
      "live-spend",
      `USD ${liveRaw.totalSpendUsd.toFixed(6)}`,
      liveRaw.totalSpendUsd,
      "results/live.json",
      "literal",
    ),
    fact(
      "probes",
      `${probesRaw.totals.passed}/${probesRaw.totals.probes}`,
      probesRaw.totals.passed,
      "results/dogfood-probes.json",
      "literal",
    ),
    fact(
      "team-spend",
      `USD ${dogfood.spend.totalUsd.toFixed(6)}`,
      dogfood.spend.totalUsd,
      "results/dogfood.json",
      "literal",
    ),
    fact(
      "team-rows",
      `${dogfood.spend.rows}`,
      dogfood.spend.rows,
      "results/dogfood.json",
      "literal",
    ),
    fact(
      "zero-cost-rows",
      `${dogfood.spend.zeroCostRows}`,
      dogfood.spend.zeroCostRows,
      "results/dogfood.json",
      "literal",
    ),
    fact(
      "zero-cost-tokens",
      `${dogfood.spend.zeroCostTokens}`,
      dogfood.spend.zeroCostTokens,
      "results/dogfood.json",
      "literal",
    ),
    fact(
      "unconstrained-simulation",
      `USD ${noLimits.totals.spendUsd.toFixed(2)}`,
      noLimits.totals.spendUsd,
      "results/sim/no-limits.json",
      "literal",
    ),
    fact(
      "demo-steps",
      `${flow.steps.length}`,
      flow.steps.length,
      "results/demo/flow.json",
      "derived",
      "demo steps",
    ),
    fact(
      "decisions",
      `${dogfood.decisions.length}`,
      dogfood.decisions.length,
      "results/dogfood.json",
      "derived",
      "decided requests",
    ),
    fact(
      "request-created-notices",
      `${dogfood.crossCutting.requestCreatedNotifications}`,
      dogfood.crossCutting.requestCreatedNotifications,
      "results/dogfood.json",
      "literal",
    ),
    fact(
      "request-decided-notices",
      `${dogfood.crossCutting.requestDecidedNotifications}`,
      dogfood.crossCutting.requestDecidedNotifications,
      "results/dogfood.json",
      "literal",
    ),
  ];

  for (const item of facts) {
    if (item.basis !== "literal") continue;
    if (!readSource(root, item.source).includes(String(item.value))) {
      throw new Error(`page: fact ${item.id} (${item.value}) is not in ${item.source}`);
    }
  }

  const data: PageData = {
    meta: {
      generatedAt: dogfood.generatedAt,
      sources,
      demoClock: flow.clock,
      demoGeneratedBy: flow.generatedBy,
    },
    summary: {
      clisVerified,
      liveStepsPassed,
      liveStepsTotal,
      probesPassed: probesRaw.totals.passed,
      probesTotal: probesRaw.totals.probes,
      teamSpendUsd: dogfood.spend.totalUsd,
      unconstrainedSimulationUsd: noLimits.totals.spendUsd,
      zeroCostRows: dogfood.spend.zeroCostRows,
      totalRows: dogfood.spend.rows,
      zeroCostTokens: dogfood.spend.zeroCostTokens,
    },
    live: {
      runAt: liveRaw.runAt,
      totalSpendUsd: liveRaw.totalSpendUsd,
      upstreamStopTripped: liveRaw.upstreamStopTripped,
      clis,
      plugin: liveRaw.plugin,
    },
    demo: { clock: flow.clock, steps: demoSteps },
    simulation,
    teamTest,
    facts,
  };

  const out = join(root, "results/page/page-data.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, stableJson(data));
  return data;
}

function fact(
  id: string,
  display: string,
  value: string | number,
  source: string,
  basis: "literal" | "derived",
  note?: string,
): PageFact {
  return note === undefined
    ? { id, display, value, source, basis }
    : { id, display, value, source, basis, note };
}

if (process.argv[1]?.endsWith("src/report/page-data.ts")) {
  const root = process.cwd();
  buildPageData(root);
  process.stdout.write("page-data: results/page/page-data.json\n");
}
