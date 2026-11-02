/**
 * Team-test evidence export.
 *
 * Reads the real team-test state from the running dogfood stack through its
 * APIs only — never from the store file — and writes the committed evidence:
 *
 *   results/dogfood/audit-crew.json          audit events, team Crew
 *   results/dogfood/audit-night.json         audit events, team Night
 *   results/dogfood/requests-crew.json       requests and their state
 *   results/dogfood/requests-night.json
 *   results/dogfood/usage-crew.json          watcher usage rows
 *   results/dogfood/usage-night.json
 *   results/dogfood/notifications-webhook.json
 *   results/dogfood/notifications-mail.json
 *   results/dogfood/gateway-spend.json       scrubbed gateway spend rows
 *   results/dogfood/refusals.json            gateway refusals, scrubbed
 *   results/dogfood.json                     the scenario report data
 *
 * Secrets are read from the 0600 files the setup script wrote; none is printed or
 * written. Gateway spend rows carry the prompt and the completion under
 * `messages`/`response`, so those fields are never copied: only the request
 * id, time, member, model, price, token counts, status and error class.
 * Key fragments and key hashes are replaced with `[redacted]`.
 *
 * Usage: node scripts/dogfood/evidence.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTROL_URL,
  GATEWAY_URL,
  LITELLM_ENV_FILE,
  MANAGER_TOKEN_FILE,
  MEMBERS,
  PORTS,
  ROOT,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const OUT_DIR = join(ROOT, "results", "dogfood");
const RESULTS_FILE = join(ROOT, "results", "dogfood.json");
const PROBES_FILE = join(ROOT, "results", "dogfood-probes.json");
const HINTS_FILE = join(process.env.HOME ?? "", ".config", "team-ai-allowance", "hints.json");
const TEST_FROM = "2026-11-01T00:00:00.000Z";
const TEST_TO = new Date().toISOString();

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-evidence: ${line}\n`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Remove key fragments, hashes, and absolute home paths from exported text. */
function scrub(value: string): string {
  return value
    .replace(/Key=[^\s(]+ \(sk-\.\.\.[A-Za-z0-9]+\)/g, "Key=[redacted]")
    .replace(/\b[0-9a-f]{64}\b/g, "[redacted]")
    .replace(/sk-\.\.\.[A-Za-z0-9]+/g, "sk-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\/home\/[^/\s]+/g, "[home]")
    .replace(/(\d+\.\d{6})\d+/g, "$1");
}

async function api(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${CONTROL_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`${path} failed: HTTP ${response.status} ${scrub(body).slice(0, 200)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path} returned non-JSON`);
  }
}

async function gateway(masterKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { authorization: `Bearer ${masterKey}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`gateway ${path} failed: HTTP ${response.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`gateway ${path} returned non-JSON`);
  }
}

interface MemberRow {
  id: string;
  displayName: string;
  teamId: string;
  role: string;
  blocked: boolean;
}

interface PolicyRow {
  status: string;
  blocked: boolean;
  blockedReason: string | null;
  allowedModels: string[];
  effectiveBudgetUsd: number | null;
  limits: Record<string, unknown>;
}

interface RequestRow {
  id: string;
  memberId: string;
  kind: string;
  amountUsd: number | null;
  modelId: string | null;
  message: string;
  state: string;
  createdAt: string;
  decidedAt: string | null;
}

interface AuditRow {
  id: string;
  at: string;
  action: string;
  objectType: string;
  objectId: string;
  actor: { type: string; id: string | null; displayName: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

interface UsageRow {
  memberId: string;
  modelId: string;
  at: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  apiFormat: string | null;
}

interface TeamExport {
  id: string;
  name: string;
  members: MemberRow[];
  requests: RequestRow[];
  audit: AuditRow[];
  usage: UsageRow[];
  details: Map<string, PolicyRow>;
}

function memberRows(value: unknown): MemberRow[] {
  return list(value).map((entry) => {
    const row = record(entry);
    return {
      id: text(row.id) ?? "",
      displayName: text(row.displayName) ?? "",
      teamId: text(row.teamId) ?? "",
      role: text(row.role) ?? "member",
      blocked: bool(row.blocked) ?? false,
    };
  });
}

function requestRows(value: unknown): RequestRow[] {
  return list(value).map((entry) => {
    const row = record(entry);
    return {
      id: text(row.id) ?? "",
      memberId: text(row.memberId) ?? "",
      kind: text(row.kind) ?? "",
      amountUsd: number(row.amountUsd),
      modelId: text(row.modelId),
      message: text(row.message) ?? "",
      state: text(row.state) ?? "",
      createdAt: text(row.createdAt) ?? "",
      decidedAt: text(row.decidedAt),
    };
  });
}

function auditRows(value: unknown): AuditRow[] {
  return list(value).map((entry) => {
    const row = record(entry);
    const actor = record(row.actor);
    return {
      id: text(row.id) ?? "",
      at: text(row.at) ?? "",
      action: text(row.action) ?? "",
      objectType: text(row.objectType) ?? "",
      objectId: text(row.objectId) ?? "",
      actor: {
        type: text(actor.type) ?? "",
        id: text(actor.id),
        displayName: text(actor.displayName),
      },
      reason: text(row.reason),
      before: row.before,
      after: row.after,
    };
  });
}

function usageRows(value: unknown): UsageRow[] {
  return list(value).map((entry) => {
    const row = record(entry);
    return {
      memberId: text(row.memberId) ?? "",
      modelId: text(row.modelId) ?? "",
      at: text(row.at) ?? "",
      inputTokens: number(row.inputTokens) ?? 0,
      outputTokens: number(row.outputTokens) ?? 0,
      costUsd: number(row.costUsd) ?? 0,
      apiFormat: text(row.apiFormat),
    };
  });
}

interface GatewayRow {
  requestId: string;
  at: string;
  user: string | null;
  model: string | null;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
  status: string | null;
  errorClass: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function gatewayRows(value: unknown): GatewayRow[] {
  return list(value).map((entry) => {
    const row = record(entry);
    const metadata = record(row.metadata);
    const error = record(metadata.error_information);
    return {
      requestId: text(row.request_id) ?? "",
      at: text(row.startTime) ?? "",
      user: text(row.user) ?? null,
      model: text(row.model) ?? null,
      spendUsd: number(row.spend) ?? 0,
      promptTokens: number(row.prompt_tokens) ?? 0,
      completionTokens: number(row.completion_tokens) ?? 0,
      status: text(row.status) ?? null,
      errorClass: text(error.error_class) ?? null,
      errorCode: text(error.error_code) ?? null,
      errorMessage:
        text(error.error_message) === null ? null : scrub(text(error.error_message) ?? ""),
    };
  });
}

interface NotificationEvent {
  at: string;
  body: Record<string, unknown>;
}

interface MailMessage {
  id: string;
  createdAt: string;
  to: string[];
  subject: string;
  body: string;
}

async function exportTeam(token: string, label: string): Promise<TeamExport> {
  const overview = record(await api(token, "/api/team/overview"));
  const team = record(overview.team);
  const teamId = text(team.id) ?? "";
  const teamName = text(team.name) ?? label;
  const members = memberRows(await api(token, "/api/team/members"));
  const requests = requestRows(await api(token, "/api/team/requests?limit=500"));
  const audit = auditRows(await api(token, "/api/team/audit?limit=500"));
  const usage = usageRows(
    await api(
      token,
      `/api/team/usage?from=${encodeURIComponent(TEST_FROM)}&to=${encodeURIComponent(TEST_TO)}`,
    ),
  );
  const details = new Map<string, PolicyRow>();
  for (const member of members) {
    const detail = record(await api(token, `/api/team/members/${member.id}`));
    const policy = record(detail.policy);
    details.set(member.id, {
      status: text(policy.status) ?? "unknown",
      blocked: bool(policy.blocked) ?? false,
      blockedReason: text(policy.blockedReason),
      allowedModels: list(policy.allowedModels)
        .map((value) => text(value))
        .filter((value): value is string => value !== null),
      effectiveBudgetUsd: number(policy.effectiveBudgetUsd),
      limits: record(policy.limits),
    });
  }
  log(
    `${teamName}: ${members.length} members, ${requests.length} requests, ${audit.length} audit rows, ${usage.length} usage rows`,
  );
  return { id: teamId, name: teamName, members, requests, audit, usage, details };
}

interface SpendSummary {
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

interface Scenario {
  id: string;
  title: string;
  member: { id: string; displayName: string; team: string } | null;
  pass: boolean;
  partial: boolean;
  expected: Array<{
    event: string;
    happened: "yes" | "no" | "partial";
    at: string | null;
    evidence: string;
  }>;
  spendUsd: number;
  requests: Array<{
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
  }>;
  gatewayMessages: Array<{ at: string; message: string; outcome: string }>;
  notes: string[];
}

function memberSpend(gatewayData: GatewayRow[], memberId: string): number {
  return round(
    gatewayData.filter((row) => row.user === memberId).reduce((sum, row) => sum + row.spendUsd, 0),
  );
}

function decisionOf(audit: AuditRow[], requestId: string): AuditRow | null {
  return (
    audit.find((row) => row.action === "request.decided" && row.objectId === requestId) ?? null
  );
}

function minutesBetween(from: string, to: string | null): number | null {
  if (to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? round(ms / 60_000, 1) : null;
}

function requestReports(team: TeamExport, memberId: string): Scenario["requests"] {
  return team.requests
    .filter((row) => row.memberId === memberId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((row) => {
      const decision = decisionOf(team.audit, row.id);
      return {
        id: row.id,
        kind: row.kind,
        amountUsd: row.amountUsd,
        modelId: row.modelId,
        message: row.message,
        state: row.state,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        decisionNote: decision?.reason ?? null,
        decidedBy:
          decision === null
            ? null
            : `${decision.actor.type}:${decision.actor.displayName ?? decision.actor.id ?? ""}`,
        minutesToDecision: minutesBetween(row.createdAt, row.decidedAt),
      };
    });
}

function notificationOf(
  webhook: NotificationEvent[],
  kind: string,
  memberId: string | null = null,
): NotificationEvent | null {
  return (
    webhook.find((event) => {
      const body = event.body;
      const matchesKind = text(body.kind) === kind;
      const matchesMember = memberId === null || text(body.memberId) === memberId;
      return matchesKind && matchesMember;
    }) ?? null
  );
}

function probeSummary(): unknown {
  try {
    const parsed = record(JSON.parse(readFileSync(PROBES_FILE, "utf8")));
    return {
      file: "results/dogfood-probes.json",
      status: text(parsed.status),
      totals: parsed.totals,
      probes: list(parsed.probes).map((entry) => {
        const probe = record(entry);
        return {
          id: text(probe.id),
          title: text(probe.title),
          pass: bool(probe.pass),
          observed: text(probe.observed),
          startedAt: text(probe.startedAt),
          finishedAt: text(probe.finishedAt),
          costUsd: number(probe.costUsd),
        };
      }),
    };
  } catch {
    return { file: "results/dogfood-probes.json", missing: true };
  }
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });
  const tokens = record(JSON.parse(readFileSync(MANAGER_TOKEN_FILE, "utf8")));
  const crewToken = text(tokens.crew);
  const nightToken = text(tokens.night);
  if (crewToken === null || nightToken === null)
    throw new Error("manager token file is incomplete");
  const masterKey = readEnvFile(LITELLM_ENV_FILE).LITELLM_MASTER_KEY;
  if (masterKey === undefined || masterKey === "") throw new Error("gateway master key is missing");

  const crew = await exportTeam(crewToken, "Crew");
  const night = await exportTeam(nightToken, "Night");

  writeFileSync(join(OUT_DIR, "audit-crew.json"), `${JSON.stringify(crew.audit, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "audit-night.json"), `${JSON.stringify(night.audit, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "requests-crew.json"), `${JSON.stringify(crew.requests, null, 2)}\n`);
  writeFileSync(
    join(OUT_DIR, "requests-night.json"),
    `${JSON.stringify(night.requests, null, 2)}\n`,
  );
  writeFileSync(join(OUT_DIR, "usage-crew.json"), `${JSON.stringify(crew.usage, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "usage-night.json"), `${JSON.stringify(night.usage, null, 2)}\n`);

  const rawGateway = await gateway(
    masterKey,
    `/spend/logs?start_date=2026-11-01&end_date=2026-11-04&summarize=false`,
  );
  const gatewayData = gatewayRows(rawGateway).sort((a, b) => a.at.localeCompare(b.at));
  writeFileSync(join(OUT_DIR, "gateway-spend.json"), `${JSON.stringify(gatewayData, null, 2)}\n`);

  const refusals = gatewayData
    .filter((row) => row.status === "failure")
    .map((row) => ({
      requestId: row.requestId,
      at: row.at,
      memberId: row.user,
      model: row.model,
      httpClass: row.errorClass,
      httpCode: row.errorCode,
      message: row.errorMessage,
    }));
  writeFileSync(join(OUT_DIR, "refusals.json"), `${JSON.stringify(refusals, null, 2)}\n`);

  const webhookBody = record(await (await fetch(`http://127.0.0.1:${PORTS.webhook}/`)).json());
  const webhook: NotificationEvent[] = list(webhookBody.events).map((entry) => {
    const event = record(entry);
    return { at: text(event.at) ?? "", body: record(event.body) };
  });
  writeFileSync(
    join(OUT_DIR, "notifications-webhook.json"),
    `${JSON.stringify(webhook, null, 2)}\n`,
  );

  const mailBody = record(
    await (await fetch(`http://127.0.0.1:${PORTS.mailUi}/api/v2/messages?limit=200`)).json(),
  );
  const mail: MailMessage[] = list(mailBody.items).map((entry) => {
    const item = record(entry);
    const content = record(item.Content);
    const headers = record(content.Headers);
    const subject = list(headers.Subject)
      .map((value) => text(value))
      .find((value) => value !== null);
    const to = list(item.To).map((value) => {
      const mailbox = record(value);
      return `${text(mailbox.Mailbox) ?? ""}@${text(mailbox.Domain) ?? ""}`;
    });
    return {
      id: text(item.ID) ?? "",
      createdAt: text(item.Created) ?? "",
      to,
      subject: subject ?? "",
      body: scrub(text(content.Body) ?? "").slice(0, 2000),
    };
  });
  writeFileSync(join(OUT_DIR, "notifications-mail.json"), `${JSON.stringify(mail, null, 2)}\n`);

  const allMembers = [...crew.members, ...night.members];
  const byId = new Map(allMembers.map((member) => [member.id, member]));
  const display = (id: string | null): string | null =>
    id === null ? null : (byId.get(id)?.displayName ?? null);

  const spendByMember = new Map<string, { spendUsd: number; rows: number }>();
  const spendByModel = new Map<string, { spendUsd: number; rows: number }>();
  let totalSpend = 0;
  let zeroCostTokens = 0;
  for (const row of gatewayData) {
    totalSpend += row.spendUsd;
    const userKey = row.user === null || row.user === "" ? "unknown" : row.user;
    const member = spendByMember.get(userKey) ?? { spendUsd: 0, rows: 0 };
    member.spendUsd += row.spendUsd;
    member.rows += 1;
    spendByMember.set(userKey, member);
    const modelKey = row.model ?? "unknown";
    const model = spendByModel.get(modelKey) ?? { spendUsd: 0, rows: 0 };
    model.spendUsd += row.spendUsd;
    model.rows += 1;
    spendByModel.set(modelKey, model);
    if (row.spendUsd === 0) zeroCostTokens += row.promptTokens + row.completionTokens;
  }
  const spend: SpendSummary = {
    totalUsd: round(totalSpend),
    rows: gatewayData.length,
    zeroCostRows: gatewayData.filter((row) => row.spendUsd === 0).length,
    zeroCostTokens,
    byMember: [...spendByMember.entries()]
      .map(([id, value]) => ({
        memberId: id === "unknown" ? null : id,
        displayName: display(id === "unknown" ? null : id),
        spendUsd: round(value.spendUsd),
        rows: value.rows,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd),
    byModel: [...spendByModel.entries()]
      .map(([model, value]) => ({ model, spendUsd: round(value.spendUsd), rows: value.rows }))
      .sort((a, b) => b.spendUsd - a.spendUsd),
  };

  const controlUsage = {
    rows: crew.usage.length + night.usage.length,
    totalUsd: round([...crew.usage, ...night.usage].reduce((sum, row) => sum + row.costUsd, 0)),
    zeroCostRows: [...crew.usage, ...night.usage].filter((row) => row.costUsd === 0).length,
    tokens: [...crew.usage, ...night.usage].reduce(
      (sum, row) => sum + row.inputTokens + row.outputTokens,
      0,
    ),
  };

  const memberOf = (repoId: string): MemberRow | null => {
    const spec = MEMBERS.find((entry) => entry.id === repoId);
    if (spec === undefined) return null;
    return allMembers.find((member) => member.displayName === spec.displayName) ?? null;
  };

  const m1 = memberOf("m1");
  const m2 = memberOf("m2");
  const m3 = memberOf("m3");
  const m4 = memberOf("m4");

  const refusalsFor = (memberId: string | null): Scenario["gatewayMessages"] =>
    refusals
      .filter((row) => memberId !== null && row.memberId === memberId)
      .map((row) => ({
        at: row.at,
        message: row.message ?? `${row.httpClass ?? "error"} ${row.httpCode ?? ""}`.trim(),
        outcome: row.httpClass ?? "failure",
      }));

  const m1Requests = m1 === null ? [] : requestReports(crew, m1.id);
  const m2Requests = m2 === null ? [] : requestReports(crew, m2.id);
  const m3Requests = m3 === null ? [] : requestReports(crew, m3.id);
  const m1Soft = m1 === null ? null : notificationOf(webhook, "soft_limit", m1.id);
  const m1StandIn =
    m1 === null
      ? null
      : (crew.audit.find(
          (row) =>
            row.action === "limits.updated" &&
            row.objectId === m1.id &&
            number(record(row.after).budgetUsd) === 0.04 &&
            row.at > "2026-11-02T08:00:00.000Z",
        ) ?? null);
  const m1Denied =
    m1Requests.find((row) => row.kind === "more_budget" && row.state === "denied") ?? null;
  const m1Refusal =
    m1 === null
      ? null
      : ([...refusals]
          .reverse()
          .find(
            (row) =>
              row.memberId === m1.id &&
              row.httpClass === "BudgetExceededError" &&
              (row.message ?? "").includes("Max budget: 0.05"),
          ) ?? null);
  const m1Blocked =
    m1 === null
      ? null
      : (crew.audit.find(
          (row) =>
            row.action === "key.state_applied" &&
            row.objectId.startsWith("taa-") &&
            row.objectId.includes(m1.id) &&
            row.at >= "2026-11-02T08:28:50",
        ) ?? null);
  const m1Detail = m1 === null ? null : (crew.details.get(m1.id) ?? null);

  const m2Denied =
    m2Requests.find((row) => row.kind === "model_unlock" && row.state === "denied") ?? null;
  const m2Approved =
    m2Requests.find((row) => row.kind === "model_unlock" && row.state === "approved") ?? null;
  const m3Auto = m3Requests.find((row) => row.decidedBy?.startsWith("rule:") === true) ?? null;
  const m3Denied = m3Requests.find((row) => row.state === "denied") ?? null;
  const m3PauseRecorded = crew.audit.some(
    (row) => row.action === "plugin.paused" || row.action === "session.paused",
  );
  const m4OffHours =
    m4 === null
      ? false
      : night.audit.some(
          (row) =>
            row.objectId === m4.id &&
            (row.reason ?? "").toLowerCase().includes("off-hours") &&
            (row.action === "member.blocked" || row.action.startsWith("watcher.")),
        );
  const m4Unblocked =
    m4 === null
      ? false
      : night.audit.some((row) => row.action === "member.unblocked" && row.objectId === m4.id);
  const hintsExist = (() => {
    try {
      readFileSync(HINTS_FILE);
      return true;
    } catch {
      return false;
    }
  })();

  const scenarios: Scenario[] = [
    {
      id: "m1",
      title: "Budget limit: soft notice, request, deny, hard refusal",
      member: m1 === null ? null : { id: m1.id, displayName: m1.displayName, team: crew.name },
      pass: false,
      partial: true,
      expected: [
        {
          event: "Soft-limit notice reaches the member",
          happened: m1Soft === null ? "no" : "yes",
          at: m1Soft === null ? null : text(m1Soft.body.at),
          evidence:
            m1Soft === null
              ? "No soft_limit notification for Mira on the webhook catcher."
              : `webhook kind=soft_limit: "${text(m1Soft.body.title) ?? ""}"`,
        },
        {
          event: "First budget request approved (+USD 0.02) through the request flow",
          happened: "no",
          at: m1StandIn?.at ?? null,
          evidence:
            m1StandIn === null
              ? "No approved request exists for Mira."
              : `No request could be filed while spend was at the hard wall, so the leader raised the limit 0.02 -> 0.04 with an audited limits.updated event instead (${m1StandIn.at}). No request row exists for this approval.`,
        },
        {
          event: 'Second request denied with "continue; the gateway will stop you at the limit"',
          happened: m1Denied === null ? "no" : "yes",
          at: m1Denied?.decidedAt ?? null,
          evidence:
            m1Denied === null
              ? "No denied budget request for Mira."
              : `${m1Denied.id}, note: "${m1Denied.decisionNote ?? ""}", ${m1Denied.minutesToDecision ?? "?"} min from filing to decision.`,
        },
        {
          event: "Live hard-limit refusal by the gateway",
          happened: m1Refusal === null ? "no" : "yes",
          at: m1Refusal?.at ?? null,
          evidence:
            m1Refusal === null
              ? "No BudgetExceededError for the USD 0.05 key."
              : (m1Refusal.message ?? ""),
        },
        {
          event: "Member ends blocked at the limit",
          happened: m1Detail?.status === "blocked" ? "yes" : "no",
          at: m1Blocked?.at ?? null,
          evidence:
            m1Detail === null
              ? "m1 detail unavailable"
              : `policy status=${m1Detail.status}, blocked=${m1Detail.blocked}, key.state_applied blocked at ${m1Blocked?.at ?? "?"}`,
        },
      ],
      spendUsd: m1 === null ? 0 : memberSpend(gatewayData, m1.id),
      requests: m1Requests,
      gatewayMessages: refusalsFor(m1?.id ?? null),
      notes: [
        "The first approval is a stand-in: the budget was raised through an audited limit PATCH because metered spend hit the wall before a request could be filed. The request flow itself was only seen on the second request.",
        "The soft notice fired while the member was already at the hard wall (the watcher saw 77% at USD 0.02 of USD 0.02); the intended warn-before-stop window did not exist.",
        "The leader recorded USD 0.056181 over 149 gateway rows at the time; this export sees 152 rows because three later refused attempts were logged after that reading. The spend is unchanged.",
      ],
    },
    {
      id: "m2",
      title: "Flagship model: deny, approve for 15 minutes, unlock, expiry",
      member: m2 === null ? null : { id: m2.id, displayName: m2.displayName, team: crew.name },
      pass: false,
      partial: true,
      expected: [
        {
          event: "First flagship request denied",
          happened: m2Denied === null ? "no" : "yes",
          at: m2Denied?.decidedAt ?? null,
          evidence:
            m2Denied === null
              ? "No denied model_unlock for Nils."
              : `${m2Denied.id}, note: "${m2Denied.decisionNote ?? ""}"`,
        },
        {
          event: "Denial shows the cheaper-model hint",
          happened: hintsExist ? "partial" : "no",
          at: m2Denied?.decidedAt ?? null,
          evidence: hintsExist
            ? "A hints file exists; the hint text itself was not captured by the worker."
            : 'No hints file was imported into the dogfood run, so the API had no cheaper-model hint to show. The denial note only said "use the enabled model".',
        },
        {
          event: "Second flagship request approved for 15 minutes",
          happened: m2Approved === null ? "no" : "yes",
          at: m2Approved?.decidedAt ?? null,
          evidence:
            m2Approved === null
              ? "No approved model_unlock for Nils."
              : `${m2Approved.id}, approved ${m2Approved.minutesToDecision ?? "?"} min after filing; the grant expires 15 minutes after approval (05:32:00Z) and the key models were reverted at 05:32:01Z.`,
        },
        {
          event: "A script proves flagship works while unlocked and is refused after expiry",
          happened: "yes",
          at: "2026-11-02T06:01:32.717Z",
          evidence:
            "D5 probe 3: flagship call 200 during the grant, 403 ModelAccessDenied after expiry plus one reconciler cycle. See results/dogfood-probes.json probe 3.",
        },
      ],
      spendUsd: m2 === null ? 0 : memberSpend(gatewayData, m2.id),
      requests: m2Requests,
      gatewayMessages: refusalsFor(m2?.id ?? null),
      notes: [
        "D5 re-issued the approval because the original 15-minute window had already closed before the probe ran; both windows are in the audit.",
      ],
    },
    {
      id: "m3",
      title: "Auto-approve rule, loop pause, graceful stop",
      member: m3 === null ? null : { id: m3.id, displayName: m3.displayName, team: crew.name },
      pass: false,
      partial: true,
      expected: [
        {
          event: "The plugin pauses on the same failing command 3x (loop rule)",
          happened: m3PauseRecorded ? "yes" : "no",
          at: null,
          evidence:
            "D3 recorded a pause, but it was the unattended rule (15 steps), not the loop rule: the harness prepends a timestamp to each shell line, so the identical-error count stayed at 1. The plugin still stopped the loop.",
        },
        {
          event: "The leader's message clears the pause",
          happened: "yes",
          at: "2026-11-02T06:04:23.000Z",
          evidence:
            'D3 evidence: leader message "The failing test is broken on purpose; stop running it, note it in the README, and continue." and a resolved status line; the work finished.',
        },
        {
          event: "First budget request auto-approved by the rule",
          happened: m3Auto === null ? "no" : "yes",
          at: m3Auto?.decidedAt ?? null,
          evidence:
            m3Auto === null
              ? "No rule-decided request for Edda."
              : `${m3Auto.id} decided by ${m3Auto.decidedBy ?? "?"}; budget 0.02 -> 0.03. Note: ${m3Auto.decisionNote ?? ""}`,
        },
        {
          event: "Second budget request denied: finish, commit, report",
          happened: m3Denied === null ? "no" : "yes",
          at: m3Denied?.decidedAt ?? null,
          evidence:
            m3Denied === null
              ? "No denied request for Edda."
              : `${m3Denied.id}, note: "${m3Denied.decisionNote ?? ""}"`,
        },
      ],
      spendUsd: m3 === null ? 0 : memberSpend(gatewayData, m3.id),
      requests: m3Requests,
      gatewayMessages: refusalsFor(m3?.id ?? null),
      notes: [
        "The auto-approve rule only matched USD 0.01; the first request asked for USD 0.02 and was cancelled by the member, then the USD 0.01 request was auto-approved. The scenario's ordering still matched the plan.",
        "Metered spend for m3 stayed at USD 0, so no threshold notice fired for this member.",
      ],
    },
    {
      id: "m4",
      title: "Off-hours cap: block, one unblock, blocked again",
      member: m4 === null ? null : { id: m4.id, displayName: m4.displayName, team: night.name },
      pass: false,
      partial: false,
      expected: [
        {
          event: "The watcher blocks the Night member for off-hours spend",
          happened: m4OffHours ? "yes" : "no",
          at: null,
          evidence: m4OffHours
            ? "Night audit contains an off-hours block for Bo."
            : `No off-hours block exists. Night audit has ${night.audit.length} rows and none mention off-hours; Bo's gateway spend is USD ${memberSpend(gatewayData, m4?.id ?? "")}, below the USD 0.01 off-hours cap.`,
        },
        {
          event: "The leader unblocks once with a note",
          happened: m4Unblocked ? "yes" : "no",
          at: null,
          evidence: m4Unblocked
            ? "Night audit contains a member.unblocked row for Bo."
            : "No member.unblocked row exists for Bo in the Night audit.",
        },
        {
          event: "Blocked again and stays blocked",
          happened: "no",
          at: null,
          evidence: "Never blocked, so there was no second block.",
        },
        {
          event: "The member reports the block",
          happened: "no",
          at: null,
          evidence:
            "D4 left no status line or evidence file; the scratch repo exists but the scenario produced no block message to report.",
        },
      ],
      spendUsd: m4 === null ? 0 : memberSpend(gatewayData, m4.id),
      requests: m4 === null ? [] : requestReports(night, m4.id),
      gatewayMessages: refusalsFor(m4?.id ?? null),
      notes: [
        "Root cause matches the metering diagnosis: worker streaming rows carry token counts but USD 0 cost, so off-hours spend never crossed the USD 0.01 cap. D4 was never blocked and stopped early.",
      ],
    },
  ];

  const crossCutting = {
    requestCreatedNotifications: webhook.filter(
      (event) => text(event.body.kind) === "request_created",
    ).length,
    requestDecidedNotifications: webhook.filter(
      (event) => text(event.body.kind) === "request_decided",
    ).length,
    unusualSpendNotifications: webhook.filter((event) => text(event.body.kind) === "unusual_spend")
      .length,
    hardLimitNotifications: webhook.filter((event) => text(event.body.kind) === "hard_limit")
      .length,
    mailMessages: mail.length,
    webhookEvents: webhook.length,
  };

  const decisionRows = [...crew.audit, ...night.audit]
    .filter((row) => row.action === "request.decided")
    .sort((a, b) => a.at.localeCompare(b.at));
  const decisions = decisionRows.map((row) => {
    const after = record(row.after);
    const request = [...crew.requests, ...night.requests].find(
      (entry) => entry.id === row.objectId,
    );
    return {
      requestId: row.objectId,
      at: row.at,
      memberId: request?.memberId ?? null,
      memberName: request === undefined ? null : (byId.get(request.memberId)?.displayName ?? null),
      filedAt: request?.createdAt ?? null,
      outcome: text(after.state),
      note: row.reason,
      decidedBy: `${row.actor.type}:${row.actor.displayName ?? row.actor.id ?? ""}`,
      minutesToDecision: request === undefined ? null : minutesBetween(request.createdAt, row.at),
    };
  });

  const auditActions = (team: TeamExport): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of team.audit) out[row.action] = (out[row.action] ?? 0) + 1;
    return out;
  };

  const auditTeam = new Map<string, string>();
  for (const row of crew.audit) auditTeam.set(row.id, crew.name);
  for (const row of night.audit) auditTeam.set(row.id, night.name);
  const auditExcerpt = [...crew.audit, ...night.audit]
    .filter(
      (row) =>
        row.action === "request.created" ||
        row.action === "request.decided" ||
        row.action === "grant.issued" ||
        row.action === "member.blocked" ||
        row.action === "member.unblocked" ||
        row.action.startsWith("watcher.") ||
        (row.action === "key.state_applied" && (row.reason ?? "").includes("blocked")),
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((row) => ({
      at: row.at,
      team: auditTeam.get(row.id) ?? crew.name,
      action: row.action,
      objectId: row.objectId,
      actor: `${row.actor.type}:${row.actor.displayName ?? row.actor.id ?? ""}`,
      reason: row.reason,
    }));

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    testWindow: { from: TEST_FROM, to: TEST_TO },
    stack: {
      gateway: `127.0.0.1:${PORTS.gateway}`,
      control: `127.0.0.1:${PORTS.control}`,
      webhook: `127.0.0.1:${PORTS.webhook}`,
      mail: `127.0.0.1:${PORTS.mailUi}`,
    },
    teams: [
      {
        name: crew.name,
        members: crew.members.length,
        requests: crew.requests.length,
        auditEvents: crew.audit.length,
        usageRows: crew.usage.length,
        auditActions: auditActions(crew),
      },
      {
        name: night.name,
        members: night.members.length,
        requests: night.requests.length,
        auditEvents: night.audit.length,
        usageRows: night.usage.length,
        auditActions: auditActions(night),
      },
    ],
    scenarios,
    members: [
      ...crew.members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        team: crew.name,
        role: member.role,
      })),
      ...night.members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        team: night.name,
        role: member.role,
      })),
    ],
    probes: probeSummary(),
    crossCutting,
    decisions,
    spend,
    controlUsage,
    auditExcerpt,
    notifications: {
      webhook: webhook.map((event) => ({
        at: text(event.body.at),
        deliveredAt: event.at,
        kind: text(event.body.kind),
        audience: text(event.body.audience),
        memberId: text(event.body.memberId),
        memberName: display(text(event.body.memberId)),
        title: text(event.body.title),
        body: text(event.body.body),
      })),
      mail: mail.map((message) => ({
        createdAt: message.createdAt,
        to: message.to,
        subject: message.subject,
        body: message.body,
      })),
    },
    whatWentWrong: [
      {
        summary: "Streaming worker-model calls are recorded with costUsd 0",
        detail: `${spend.zeroCostRows} of ${spend.rows} gateway rows cost USD 0 while carrying ${spend.zeroCostTokens.toLocaleString("en-US")} tokens in total. Non-streaming metered calls price exactly. Every spend-gated event (soft notice, caps, request flow) therefore needed meter.ts to accrue spend by hand, and m4's off-hours cap never fired.`,
      },
      {
        summary: "The first m1 approval was a budget edit, not a request decision",
        detail:
          "Metered spend hit the hard wall before a request could be filed, so the leader raised m1's budget 0.02 -> 0.04 with an audited limits.updated PATCH. The request flow was first exercised by the second request, which was denied.",
      },
      {
        summary: "Request created and decided notifications are never sent",
        detail:
          "The webhook and MailHog show 0 request_created and 0 request_decided notices. D5 probe 6 found the same defect: the core creates and decides requests without calling the notifier.",
      },
      {
        summary: "Notification audit rows are invisible through the team API",
        detail:
          "Delivered notices write notification.sent rows with a NULL team_id, so /api/team/audit returns none of them. Every notification in this export comes from the catchers, not the team audit.",
      },
      {
        summary: "Expired grants and requests are not audited",
        detail:
          "The flagship grant was removed from the key at 05:32:01Z, but no grant.expired row exists and grants have no expiredAt field. Nothing called expireDue() during the run.",
      },
      {
        summary: "The loop rule did not trip on the intended trigger",
        detail:
          "D3 ran the same failing pytest command three times, but the harness prefix changed one line, so the identical-error counter stayed at 1. The unattended rule paused the session instead. The loop rule itself was therefore not proven on a real agent.",
      },
      {
        summary: "m4's off-hours scenario did not run",
        detail:
          "Bo never crossed the USD 0.01 off-hours cap (gateway spend USD 0.002574), so there was no block, no unblock and no second block. D4 left no evidence file.",
      },
      {
        summary: "The hard budget is floored to whole cents",
        detail:
          "floorCents(0.04 x 1.3) gives USD 0.05 rather than USD 0.052, and the same rounding removed the grace band from the cent-sized budgets. Notifications and test expectations have to use the floored figure.",
      },
      {
        summary: "Catalogue prices differ from gateway prices by 10x",
        detail:
          "The model catalogue and scripts/dogfood/config.ts use USD 5/15 per 1M tokens; the gateway prices calls at USD 0.5/1.5 per 1M. This report uses the gateway spend, which is authoritative.",
      },
      {
        summary: "The D6 console login needed a temporary account",
        detail:
          "D0 generated the Leader console passwords randomly and kept them only in the control process's memory; the control restarted during the test, so the passwords were unrecoverable. D6 created one temporary manager per team through the admin API, took the screenshots, and left both accounts to be deleted with their teams. Their member.created rows appear after this export; the Overview tables show a D6 Console row.",
      },
      {
        summary: "Upstream DNS failed after the host reboot",
        detail:
          "Six gateway failure rows are OpenAIException connection errors between 02:21Z and 02:25Z; the host's podman DNS was deaf and was restarted. They are upstream failures, not budget refusals.",
      },
      {
        summary: "The member page's Key card says Active while the member is Blocked",
        detail:
          "Mira's policy status is blocked and the gateway key is blocked, but the Key card reads `member.blocked`, which only tracks a manual key block, not the watcher's threshold block. The page shows a green Active pill next to the red Blocked badge. Visible in member-m1-crew-1280-light.png.",
      },
      {
        summary: "Deleting a member after its key was revoked returns 500",
        detail:
          "D6 revoked the gateway keys first, as the cleanup order requires. The member delete route then asked the gateway to delete the same key again and answered 500 instead of treating a missing key as already deleted. The member rows had to be removed by deleting the team. DELETE /api/admin/teams/:id/members/:memberId should be idempotent.",
      },
    ],
    screenshots: [] as string[],
    artifacts: {
      auditCrew: "results/dogfood/audit-crew.json",
      auditNight: "results/dogfood/audit-night.json",
      requestsCrew: "results/dogfood/requests-crew.json",
      requestsNight: "results/dogfood/requests-night.json",
      usageCrew: "results/dogfood/usage-crew.json",
      usageNight: "results/dogfood/usage-night.json",
      gatewaySpend: "results/dogfood/gateway-spend.json",
      refusals: "results/dogfood/refusals.json",
      webhook: "results/dogfood/notifications-webhook.json",
      mail: "results/dogfood/notifications-mail.json",
      probes: "results/dogfood-probes.json",
    },
  };

  writeFileSync(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${RESULTS_FILE} and ${OUT_DIR}`);
  log(
    `spend USD ${spend.totalUsd} over ${spend.rows} gateway rows; ${decisions.length} decisions; ${webhook.length} webhook notices; ${mail.length} mails`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
