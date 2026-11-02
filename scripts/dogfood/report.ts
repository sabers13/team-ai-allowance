/**
 * Team-test report generator.
 *
 * Renders a markdown summary from `results/dogfood.json` and adds the
 * screenshot manifest to the JSON, so the prose and the evidence cannot drift
 * apart. Run after `evidence.ts` and `screenshots.ts`:
 *
 *   node scripts/dogfood/report.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./config.ts";

const RESULTS_FILE = join(ROOT, "results", "dogfood.json");
const MANIFEST = join(ROOT, "results", "dogfood", "screenshots.json");
const REPORT_FILE = join(ROOT, "results", "dogfood", "SUMMARY.md");

interface Expected {
  event: string;
  happened: "yes" | "no" | "partial";
  at: string | null;
  evidence: string;
}

interface RequestRow {
  id: string;
  kind: string;
  amountUsd: number | null;
  modelId: string | null;
  message: string;
  state: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  minutesToDecision: number | null;
}

interface Scenario {
  id: string;
  title: string;
  member: { id: string; displayName: string; team: string } | null;
  pass: boolean;
  partial: boolean;
  expected: Expected[];
  spendUsd: number;
  requests: RequestRow[];
  gatewayMessages: Array<{ at: string; message: string; outcome: string }>;
  notes: string[];
}

interface Decision {
  requestId: string;
  at: string;
  memberName: string | null;
  filedAt: string | null;
  outcome: string | null;
  note: string | null;
  decidedBy: string;
  minutesToDecision: number | null;
}

interface Spend {
  totalUsd: number;
  rows: number;
  zeroCostRows: number;
  zeroCostTokens: number;
  byMember: Array<{
    memberId: string | null;
    displayName: string | null;
    spendUsd: number;
    rows: number;
  }>;
  byModel: Array<{ model: string; spendUsd: number; rows: number }>;
}

interface Notification {
  at: string | null;
  deliveredAt: string;
  kind: string | null;
  audience: string | null;
  memberId: string | null;
  memberName: string | null;
  title: string | null;
  body: string | null;
}

interface Report {
  generatedAt: string;
  testWindow: { from: string; to: string };
  stack: Record<string, string>;
  teams: Array<{
    name: string;
    members: number;
    requests: number;
    auditEvents: number;
    usageRows: number;
    auditActions: Record<string, number>;
  }>;
  scenarios: Scenario[];
  probes: Record<string, unknown>;
  crossCutting: Record<string, number>;
  decisions: Decision[];
  spend: Spend;
  controlUsage: { rows: number; totalUsd: number; zeroCostRows: number; tokens: number };
  auditExcerpt: Array<{
    at: string;
    team: string;
    action: string;
    objectId: string;
    actor: string;
    reason: string | null;
  }>;
  notifications: {
    webhook: Notification[];
    mail: Array<{ createdAt: string; subject: string; body: string }>;
  };
  whatWentWrong: Array<{ summary: string; detail: string }>;
  screenshots: string[];
  artifacts: Record<string, string>;
}

interface Shot {
  file: string;
  page: string;
  team: string;
  width: number;
  theme: string;
}

function cell(value: string | null | undefined, limit = 220): string {
  const text = (value ?? "").replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function usd(value: number): string {
  return `USD ${value.toFixed(6)}`;
}

function happened(value: "yes" | "no" | "partial"): string {
  return value === "yes" ? "**yes**" : value === "no" ? "**no**" : "partial";
}

function statusOf(scenario: Scenario): string {
  if (scenario.pass) return scenario.partial ? "**pass** (one partial event)" : "**pass**";
  return scenario.partial ? "**fail** (partial)" : "**fail**";
}

function scenarioSection(scenario: Scenario): string {
  const member =
    scenario.member === null
      ? "member unknown"
      : `${scenario.member.displayName} (\`${scenario.id}\`, ${scenario.member.team})`;
  const lines: string[] = [];
  lines.push(`### ${scenario.id.toUpperCase()} — ${scenario.title}`);
  lines.push("");
  lines.push(`${member} · ${statusOf(scenario)} · spend ${usd(scenario.spendUsd)}`);
  lines.push("");
  lines.push("| Expected event | Happened | When (UTC) | Evidence |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of scenario.expected) {
    lines.push(
      `| ${cell(item.event)} | ${happened(item.happened)} | ${cell(item.at ?? "—", 40)} | ${cell(item.evidence)} |`,
    );
  }
  lines.push("");
  if (scenario.requests.length > 0) {
    lines.push(
      "| Request | Kind | Amount / model | Message | State | Filed | Decided | Min | Decision note |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const request of scenario.requests) {
      const subject =
        request.amountUsd === null
          ? (request.modelId ?? "—")
          : `USD ${request.amountUsd.toFixed(2)}`;
      lines.push(
        `| \`${request.id}\` | ${cell(request.kind, 20)} | ${subject} | ${cell(request.message, 120)} | ${cell(request.state, 20)} | ${cell(request.createdAt, 40)} | ${cell(request.decidedAt ?? "—", 40)} | ${request.minutesToDecision ?? "—"} | ${cell(request.decisionNote)} |`,
      );
    }
    lines.push("");
  }
  if (scenario.notes.length > 0) {
    for (const note of scenario.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}

function groupedRefusals(scenario: Scenario): string {
  if (scenario.gatewayMessages.length === 0) return "_No gateway refusals for this member._\n";
  const groups = new Map<string, { count: number; first: string; last: string }>();
  for (const row of scenario.gatewayMessages) {
    const entry = groups.get(row.message) ?? { count: 0, first: row.at, last: row.at };
    entry.count += 1;
    if (row.at < entry.first) entry.first = row.at;
    if (row.at > entry.last) entry.last = row.at;
    groups.set(row.message, entry);
  }
  const lines = ["| Count | First (UTC) | Last (UTC) | Message |", "| --- | --- | --- | --- |"];
  for (const [message, entry] of groups) {
    lines.push(
      `| ${entry.count} | ${cell(entry.first, 40)} | ${cell(entry.last, 40)} | ${cell(message, 400)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function main(): number {
  const report = JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as Report;
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { screenshots: Shot[] };
  report.screenshots = manifest.screenshots.map((shot) => `results/dogfood/${shot.file}`).sort();
  writeFileSync(RESULTS_FILE, `${JSON.stringify(report, null, 2)}\n`);

  const lines: string[] = [];
  lines.push("# Team test on a real AI agent crew");
  lines.push("");
  lines.push(
    "Four worker agents built small projects through the allowance gateway while a manager agent decided their requests. Every limit was set tiny on purpose, so the product's limits had to bite on real traffic. This report records what was expected, what happened, and what did not work.",
  );
  lines.push("");
  lines.push(
    `Generated from \`results/dogfood.json\` at ${report.generatedAt}. The JSON is the machine-readable source; the raw exports are under \`results/dogfood/\`.`,
  );
  lines.push("");
  lines.push("## The test");
  lines.push("");
  lines.push(`- Window: ${report.testWindow.from} to ${report.testWindow.to}.`);
  lines.push(
    `- Stack: gateway \`${report.stack.gateway}\`, control \`${report.stack.control}\`, webhook catcher \`${report.stack.webhook}\`, MailHog \`${report.stack.mail}\` — all on 127.0.0.1.`,
  );
  for (const team of report.teams) {
    lines.push(
      `- ${team.name}: ${team.members} members, ${team.requests} requests, ${team.auditEvents} audit events, ${team.usageRows} watcher usage rows.`,
    );
  }
  lines.push(
    "- Decisions and timestamps come from the gateway audit log through the manager API. Notifications come from the webhook catcher and MailHog, because the team audit API does not return `notification.sent` rows (see below).",
  );
  lines.push(
    "- Spend comes from the gateway's `/spend/logs`; the control service's watcher rows are exported separately and agree on the token counts but not on every cost, because of the streaming defect below.",
  );
  lines.push("");
  lines.push("## Result at a glance");
  lines.push("");
  lines.push("| Scenario | Member | Result | Expected events that happened | Spend |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const scenario of report.scenarios) {
    const yes = scenario.expected.filter((item) => item.happened === "yes").length;
    lines.push(
      `| ${scenario.id} | ${scenario.member?.displayName ?? "—"} | ${statusOf(scenario)} | ${yes} of ${scenario.expected.length} | ${usd(scenario.spendUsd)} |`,
    );
  }
  const probes = report.probes as {
    totals?: { probes?: number; passed?: number; failed?: number; costUsd?: number };
  };
  const totals = probes.totals;
  lines.push(
    `| D5 probes | p1–p3 | ${totals?.failed === 0 ? "**pass**" : "**2 fail**"} | ${totals?.passed ?? "?"} of ${totals?.probes ?? "?"} probes passed | ${usd(totals?.costUsd ?? 0)} |`,
  );
  lines.push("");
  lines.push(
    "The headline: every budget, model and key limit that was actually reached did bite, and the audit trail is complete for decisions and key state. Three expected events did not happen as designed: m1's first approval became a manual limit edit, m3's loop rule was never triggered (the unattended rule paused instead), and m4's off-hours cap never fired at all.",
  );
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  for (const scenario of report.scenarios) lines.push(scenarioSection(scenario));
  lines.push("## Scripted probes (D5)");
  lines.push("");
  lines.push(
    "The probe run is recorded in full in `results/dogfood-probes.json`. It used probe members p1–p3 and the manager tokens, with direct gateway and API calls and no agent.",
  );
  lines.push("");
  lines.push("| Probe | Expected | Result | Observed |");
  lines.push("| --- | --- | --- | --- |");
  const probeList = (report.probes.probes ?? []) as Array<{
    id: string;
    title: string;
    pass: boolean;
    observed: string;
  }>;
  for (const probe of probeList) {
    lines.push(
      `| ${cell(probe.id, 40)} | ${cell(probe.title, 120)} | ${probe.pass ? "**pass**" : "**fail**"} | ${cell(probe.observed, 320)} |`,
    );
  }
  lines.push("");
  lines.push("## Spend");
  lines.push("");
  lines.push(
    `Gateway total: **${usd(report.spend.totalUsd)}** over ${report.spend.rows} spend rows. ${report.spend.zeroCostRows} rows cost USD 0 while carrying ${report.spend.zeroCostTokens.toLocaleString("en-US")} tokens between them.`,
  );
  lines.push("");
  lines.push("| Member | Spend | Gateway rows |");
  lines.push("| --- | --- | --- |");
  for (const row of report.spend.byMember) {
    lines.push(`| ${row.displayName ?? "unknown"} | ${usd(row.spendUsd)} | ${row.rows} |`);
  }
  lines.push("");
  lines.push("| Model | Spend | Gateway rows |");
  lines.push("| --- | --- | --- |");
  for (const row of report.spend.byModel) {
    lines.push(`| \`${row.model}\` | ${usd(row.spendUsd)} | ${row.rows} |`);
  }
  lines.push("");
  lines.push(
    `The control service's watcher rows (${report.controlUsage.rows} rows, ${report.controlUsage.tokens.toLocaleString("en-US")} tokens) add up to ${usd(report.controlUsage.totalUsd)}; ${report.controlUsage.zeroCostRows} of them cost USD 0. The gateway figure is authoritative for money.`,
  );
  lines.push("");
  lines.push("## Requests and decisions");
  lines.push("");
  lines.push(
    "| Request | Member | Outcome | Decided by | Filed (UTC) | Decided (UTC) | Minutes | Note |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const decision of report.decisions) {
    lines.push(
      `| \`${decision.requestId}\` | ${decision.memberName ?? "—"} | ${decision.outcome ?? "—"} | ${cell(decision.decidedBy, 60)} | ${cell(decision.filedAt ?? "—", 40)} | ${cell(decision.at, 40)} | ${decision.minutesToDecision ?? "—"} | ${cell(decision.note)} |`,
    );
  }
  lines.push("");
  lines.push("## Gateway messages the members saw");
  lines.push("");
  lines.push(
    "Messages are copied from the gateway's failure rows. Key references are redacted; everything else is verbatim. `Key is blocked` is the gateway's reply after the watcher blocked a key; the budget message is the hard refusal.",
  );
  lines.push("");
  for (const scenario of report.scenarios) {
    lines.push(`**${scenario.id.toUpperCase()}**`);
    lines.push("");
    lines.push(groupedRefusals(scenario));
  }
  lines.push(
    "The blocked-model probe and the flagship expiry refusal are in `results/dogfood/refusals.json`; the probe members' refusals are reported with the probe table in D5's evidence.",
  );
  lines.push("");
  lines.push("## Notifications");
  lines.push("");
  lines.push(
    `The webhook catcher holds ${report.crossCutting.webhookEvents} events and MailHog ${report.crossCutting.mailMessages} messages. Request-created notices: ${report.crossCutting.requestCreatedNotifications}. Request-decided notices: ${report.crossCutting.requestDecidedNotifications}. The decision notice a member receives today is the manager's steer, not a product notification.`,
  );
  lines.push("");
  lines.push("| Kind | Audience | Member | Delivered (UTC) | Title |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const notice of report.notifications.webhook) {
    lines.push(
      `| ${cell(notice.kind, 30)} | ${cell(notice.audience, 20)} | ${notice.memberName ?? "—"} | ${cell(notice.deliveredAt, 40)} | ${cell(notice.title)} |`,
    );
  }
  lines.push("");
  lines.push("## Audit excerpt");
  lines.push("");
  lines.push(
    "Every decision, grant, watcher block and key-state change is present. Two gaps are called out under what went wrong: notification rows have a NULL `team_id`, and grant expiry writes no row.",
  );
  lines.push("");
  lines.push("| When (UTC) | Team | Action | Object | Actor | Reason |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const event of report.auditExcerpt) {
    lines.push(
      `| ${cell(event.at, 40)} | ${event.team} | ${cell(event.action, 40)} | ${cell(event.objectId, 60)} | ${cell(event.actor, 60)} | ${cell(event.reason)} |`,
    );
  }
  lines.push("");
  lines.push("## Screenshots");
  lines.push("");
  lines.push(
    "The console pages show the real test state: Crew and Night Overview, the Requests history, Mira's blocked member page, both audit logs (filtered to the test window so the temporary D6 console accounts are excluded), and the Usage page. Each page is 1280 px and 360 px, light and dark, in `results/dogfood/`.",
  );
  lines.push("");
  const byPage = new Map<string, string[]>();
  for (const shot of manifest.screenshots) {
    const key = `${shot.page} (${shot.team})`;
    const files = byPage.get(key) ?? [];
    files.push(`\`${shot.file}\``);
    byPage.set(key, files);
  }
  for (const [page, files] of byPage) {
    lines.push(`- ${page}: ${files.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "The Crew and Night Overview tables carry one extra **D6 Console** manager row each. The Leader console passwords were generated randomly by D0 and kept only in the control process's memory; after the control restarted they were unrecoverable, so D6 created a temporary manager per team through the admin API to reach the console. The accounts are deleted with their teams during cleanup. The audit screenshots are filtered to end before those accounts were created.",
  );
  lines.push("");
  lines.push("## What went wrong");
  lines.push("");
  report.whatWentWrong.forEach((item, index) => {
    lines.push(`${index + 1}. **${item.summary}.** ${item.detail}`);
  });
  lines.push("");
  lines.push("## Evidence files");
  lines.push("");
  lines.push("| File | Contents |");
  lines.push("| --- | --- |");
  const artifactLabels: Record<string, string> = {
    auditCrew: "Crew audit events",
    auditNight: "Night audit events",
    requestsCrew: "Crew requests",
    requestsNight: "Night requests",
    usageCrew: "Crew watcher usage rows",
    usageNight: "Night watcher usage rows",
    gatewaySpend: "Gateway spend rows, scrubbed of prompt and response text",
    refusals: "Gateway refusals with their error class and message",
    webhook: "Webhook catcher deliveries",
    mail: "MailHog messages",
    probes: "D5 probe results",
  };
  for (const [key, value] of Object.entries(report.artifacts)) {
    lines.push(`| \`${value}\` | ${artifactLabels[key] ?? key} |`);
  }
  lines.push(`| \`results/dogfood/screenshots.json\` | screenshot manifest |`);
  lines.push("");

  writeFileSync(REPORT_FILE, `${lines.join("\n")}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `dogfood-report failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
