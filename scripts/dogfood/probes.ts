/**
 * Scripted feature probes for the team test.
 *
 * No agent and no MCP session: every probe is a direct HTTP call to the local
 * dogfood stack, using the probe members' key files (mode 0600) and the
 * manager token files (mode 0600). No key or token is ever printed or put on a
 * command line; the script never writes one to the results.
 *
 * Probes, in order:
 *   1. token cap (p1); 2. key block/unblock/rotate (p2);
 *   3. m2's flagship unlock works, then expires after one reconciler cycle;
 *   4. request handling; 5. blocked-model refusal;
 *   6. notifications exactly once; 7. audit completeness.
 *
 * Usage (phases let a long expiry wait be resumed):
 *   node scripts/dogfood/probes.ts all
 *   node scripts/dogfood/probes.ts --phase=core        # probes 1, 2, 4, 5
 *   node scripts/dogfood/probes.ts --phase=request     # probe 4 only
 *   node scripts/dogfood/probes.ts --phase=flagship    # probe 3 (waits ~15 min)
 *   node scripts/dogfood/probes.ts --phase=notify      # probe 6
 *   node scripts/dogfood/probes.ts --phase=audit       # probe 7, finalise
 *
 * Results: `results/dogfood-probes.json`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  CONTROL_URL,
  DB_PATH,
  GATEWAY_URL,
  keyPath,
  LITELLM_ENV_FILE,
  MANAGER_TOKEN_FILE,
  MEMBERS,
  PORTS,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS_FILE = join(ROOT, "results", "dogfood-probes.json");

const MODEL = "deepseek-v4.1-flash";
const FLAGSHIP = "flagship";
const BLOCKED_MODEL = "blocked-model";
const CALL_TIMEOUT_MS = 180_000;
const WAIT_TIMEOUT_MS = 90_000;
const RECONCILE_WAIT_MS = 30_000;
const EXPIRY_MS = 15 * 60 * 1000;
const TINY_MAX_TOKENS = 2;
const SMALL_MAX_TOKENS = 4;

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

interface ProbeRecord {
  id: string;
  title: string;
  expected: string;
  observed: string;
  pass: boolean;
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  checks: Check[];
  evidence: Record<string, unknown>;
}

interface ResultsFile {
  version: 1;
  status: "in-progress" | "complete";
  generatedAt: string;
  runStartedAt: string;
  stack: { gateway: string; control: string; webhook: string; mail: string };
  members: Record<string, string>;
  probes: ProbeRecord[];
  notifications: unknown;
  audit: unknown;
  totals: { probes: number; passed: number; failed: number; costUsd: number };
  notes: string[];
}

interface MemberInfo {
  id: string;
  displayName: string;
  teamId: string;
  blocked: boolean;
  blockedReason: string | null;
  allowedModels: string[];
  status: string;
  grants: GrantInfo[];
}

interface GrantInfo {
  id: string;
  scope: string;
  amountUsd: number | null;
  modelId: string | null;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface GatewayCall {
  status: number;
  ok: boolean;
  requestId: string | null;
  promptTokens: number;
  completionTokens: number;
  errorType: string | null;
  errorMessage: string | null;
  at: string;
}

interface UseRow {
  requestId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface AuditEvent {
  at: string;
  action: string;
  objectType: string;
  objectId: string;
  actor: { type: string; id: string | null; displayName: string | null };
  reason: string | null;
}

interface WebhookEvent {
  at: string;
  payload: Record<string, unknown>;
}

interface MailMessage {
  id: string;
  created: string;
  subject: string;
  body: string;
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-probes: ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readSecret(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (value === "") throw new Error(`secret file is empty: ${path}`);
  return value;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 800);
}

async function api(
  path: string,
  options: { token: string; method?: string; body?: unknown; secrets: readonly string[] },
): Promise<{ status: number; body: unknown; text: string }> {
  const method = options.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${CONTROL_URL}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text: scrub(text, options.secrets) };
}

async function callModel(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
  secrets: readonly string[],
): Promise<GatewayCall> {
  const at = nowIso();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = obj(JSON.parse(text));
    } catch {
      body = {};
    }
    const error = obj(body.error);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      requestId: str(body.id),
      promptTokens: num(obj(body.usage).prompt_tokens) ?? 0,
      completionTokens: num(obj(body.usage).completion_tokens) ?? 0,
      errorType: str(error.type),
      errorMessage:
        str(error.message) ?? (text.length > 0 ? scrub(text, secrets) : `HTTP ${response.status}`),
      at,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function overview(
  token: string,
  secrets: readonly string[],
): Promise<{
  teamId: string;
  teamName: string;
  members: Array<{ id: string; displayName: string; teamId: string }>;
}> {
  const response = await api("/api/team/overview", { token, secrets });
  if (response.status !== 200) throw new Error(`overview failed: HTTP ${response.status}`);
  const body = obj(response.body);
  const team = obj(body.team);
  return {
    teamId: str(team.id) ?? "",
    teamName: str(team.name) ?? "",
    members: arr(body.members).map((row) => {
      const member = obj(obj(row).member);
      return {
        id: str(member.id) ?? "",
        displayName: str(member.displayName) ?? "",
        teamId: str(member.teamId) ?? "",
      };
    }),
  };
}

async function memberDetail(
  token: string,
  memberId: string,
  secrets: readonly string[],
): Promise<MemberInfo | null> {
  const response = await api(`/api/team/members/${memberId}`, { token, secrets });
  if (response.status !== 200) return null;
  const body = obj(response.body);
  const member = obj(body.member);
  const policy = obj(body.policy);
  return {
    id: str(member.id) ?? memberId,
    displayName: str(member.displayName) ?? "",
    teamId: str(member.teamId) ?? "",
    blocked: bool(member.blocked) ?? false,
    blockedReason: str(member.blockedReason),
    allowedModels: arr(policy.allowedModels)
      .map((value) => str(value))
      .filter((value): value is string => value !== null),
    status: str(policy.status) ?? "unknown",
    grants: arr(body.grants).map((row) => {
      const grant = obj(row);
      return {
        id: str(grant.id) ?? "",
        scope: str(grant.scope) ?? "",
        amountUsd: num(grant.amountUsd),
        modelId: str(grant.modelId),
        startsAt: str(grant.startsAt) ?? "",
        expiresAt: str(grant.expiresAt),
        revokedAt: str(grant.revokedAt),
      };
    }),
  };
}

async function memberSpend(
  token: string,
  memberId: string,
  secrets: readonly string[],
): Promise<number> {
  const response = await api("/api/team/overview", { token, secrets });
  if (response.status !== 200) return 0;
  for (const row of arr(obj(response.body).members)) {
    const member = obj(obj(row).member);
    if (str(member.id) === memberId) return num(obj(row).spendUsd) ?? 0;
  }
  return 0;
}

async function waitForMember(
  token: string,
  memberId: string,
  secrets: readonly string[],
  predicate: (member: MemberInfo) => boolean,
  timeoutMs: number,
): Promise<{ member: MemberInfo | null; elapsedMs: number }> {
  const start = Date.now();
  let latest: MemberInfo | null = null;
  while (Date.now() - start <= timeoutMs) {
    latest = await memberDetail(token, memberId, secrets);
    if (latest !== null && predicate(latest)) {
      return { member: latest, elapsedMs: Date.now() - start };
    }
    await sleep(2_000);
  }
  return { member: latest, elapsedMs: Date.now() - start };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Test-denominated cost of the calls, straight from the gateway spend log. */
async function gatewaySpend(
  requestIds: readonly string[],
  runStartedAt: string,
): Promise<{ totalUsd: number; found: number; rows: UseRow[] }> {
  if (requestIds.length === 0) return { totalUsd: 0, found: 0, rows: [] };
  const env = readEnvFile(LITELLM_ENV_FILE);
  const master = env.LITELLM_MASTER_KEY;
  if (master === undefined || master === "") return { totalUsd: 0, found: 0, rows: [] };
  const start = utcDate(new Date(runStartedAt));
  const end = utcDate(addDays(new Date(), 1));
  const wanted = new Set(requestIds);
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    const response = await fetch(
      `${GATEWAY_URL}/spend/logs?start_date=${start}&end_date=${end}&summarize=false`,
      { headers: { authorization: `Bearer ${master}` } },
    );
    if (response.ok) {
      const rows = arr(await response.json()).map((value) => {
        const row = obj(value);
        return {
          requestId: str(row.request_id) ?? "",
          costUsd: num(row.spend) ?? 0,
          inputTokens: num(row.prompt_tokens) ?? 0,
          outputTokens: num(row.completion_tokens) ?? 0,
        };
      });
      const matched = rows.filter((row) => wanted.has(row.requestId));
      if (matched.length >= wanted.size) {
        return {
          totalUsd: matched.reduce((sum, row) => sum + row.costUsd, 0),
          found: matched.length,
          rows: matched,
        };
      }
    }
    await sleep(2_000);
  }
  return { totalUsd: 0, found: 0, rows: [] };
}

async function webhookEvents(): Promise<WebhookEvent[]> {
  const response = await fetch(`http://127.0.0.1:${PORTS.webhook}/`);
  if (!response.ok) return [];
  const body = obj(await response.json());
  return arr(body.events).map((value) => {
    const event = obj(value);
    return { at: str(event.at) ?? "", payload: obj(event.body) };
  });
}

function decodeMailBody(raw: string): string {
  if (!raw.includes("=0A") && !raw.includes("=3D")) return raw;
  return raw
    .replace(/=\r?\n/gu, "")
    .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

async function mailMessages(): Promise<MailMessage[]> {
  const response = await fetch(`http://127.0.0.1:${PORTS.mailUi}/api/v2/messages?limit=200`);
  if (!response.ok) return [];
  const body = obj(await response.json());
  return arr(body.items).map((value) => {
    const item = obj(value);
    const content = obj(item.Content);
    const headers = obj(content.Headers);
    const subject = arr(headers.Subject).map((entry) => str(entry) ?? "")[0] ?? "";
    return {
      id: str(item.ID) ?? "",
      created: str(item.Created) ?? "",
      subject,
      body: decodeMailBody(str(content.Body) ?? ""),
    };
  });
}

async function auditEvents(
  token: string,
  fromIso: string,
  secrets: readonly string[],
): Promise<AuditEvent[]> {
  const response = await api(`/api/team/audit?limit=1000&from=${encodeURIComponent(fromIso)}`, {
    token,
    secrets,
  });
  if (response.status !== 200) return [];
  return arr(response.body).map((value) => {
    const event = obj(value);
    const actor = obj(event.actor);
    return {
      at: str(event.at) ?? "",
      action: str(event.action) ?? "",
      objectType: str(event.objectType) ?? "",
      objectId: str(event.objectId) ?? "",
      actor: {
        type: str(actor.type) ?? "",
        id: str(actor.id),
        displayName: str(actor.displayName),
      },
      reason: str(event.reason),
    };
  });
}

function countEvents(
  events: readonly AuditEvent[],
  action: string,
  objectId: string,
): AuditEvent[] {
  return events.filter((event) => event.action === action && event.objectId === objectId);
}

/**
 * Count one audit row directly in the local store. Used only to tell a missing
 * event apart from an event the team-scoped API cannot see; no prompt or
 * response text is read.
 */
function storeAuditCount(action: string, objectId: string): number {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = ? AND object_id = ?")
        .get(action, objectId) as { count?: number } | undefined;
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

function makeCheck(name: string, expected: string, observed: string, pass: boolean): Check {
  return { name, expected, observed, pass };
}

function loadResults(): ResultsFile | null {
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as ResultsFile;
  } catch {
    return null;
  }
}

function writeResults(results: ResultsFile): void {
  results.generatedAt = nowIso();
  const passed = results.probes.filter((probe) => probe.pass).length;
  results.totals = {
    probes: results.probes.length,
    passed,
    failed: results.probes.length - passed,
    costUsd: Math.round(results.probes.reduce((sum, probe) => sum + probe.costUsd, 0) * 1e6) / 1e6,
  };
  results.probes.sort((left, right) => left.id.localeCompare(right.id));
  writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
}

function upsertProbe(results: ResultsFile, record: ProbeRecord): void {
  const index = results.probes.findIndex((probe) => probe.id === record.id);
  if (index >= 0) {
    const previous = results.probes[index];
    if (previous !== undefined) record.costUsd += previous.costUsd;
    results.probes[index] = record;
  } else {
    results.probes.push(record);
  }
  writeResults(results);
}

/** Total test-denominated spend of the probe members since the run started. */
async function actualProbeSpend(context: Context): Promise<number | null> {
  const env = readEnvFile(LITELLM_ENV_FILE);
  const master = env.LITELLM_MASTER_KEY;
  if (master === undefined || master === "") return null;
  const start = utcDate(new Date(context.results.runStartedAt));
  const end = utcDate(addDays(new Date(), 1));
  const response = await fetch(
    `${GATEWAY_URL}/spend/logs?start_date=${start}&end_date=${end}&summarize=false`,
    { headers: { authorization: `Bearer ${master}` } },
  );
  if (!response.ok) return null;
  const probeMembers = new Set([context.p1.id, context.p2.id, context.p3.id, context.m2.id]);
  let total = 0;
  for (const value of arr(await response.json())) {
    const row = obj(value);
    const user = str(row.user);
    const at = str(row.startTime) ?? "";
    if (user === null || !probeMembers.has(user) || at < context.results.runStartedAt) continue;
    total += num(row.spend) ?? 0;
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Point the totals at the gateway's own spend log and attribute any repeat-run
 * spend to the notification probe, which is the only probe that makes model
 * calls more than once while the results are kept.
 */
async function reconcileCosts(context: Context): Promise<void> {
  const actual = await actualProbeSpend(context);
  if (actual === null) return;
  const notify = context.results.probes.find((probe) => probe.id === "6-notifications");
  if (notify !== undefined) {
    const others = context.results.probes
      .filter((probe) => probe.id !== "6-notifications")
      .reduce((sum, probe) => sum + probe.costUsd, 0);
    notify.costUsd = Math.max(0, Math.round((actual - others) * 1e6) / 1e6);
  }
  context.results.notes.push(`cost reconciled from the gateway spend log: ${money(actual)}`);
}

function freshResults(): ResultsFile {
  return {
    version: 1,
    status: "in-progress",
    generatedAt: nowIso(),
    runStartedAt: nowIso(),
    stack: {
      gateway: GATEWAY_URL,
      control: CONTROL_URL,
      webhook: `http://127.0.0.1:${PORTS.webhook}`,
      mail: `http://127.0.0.1:${PORTS.mailUi}`,
    },
    members: {},
    probes: [],
    notifications: null,
    audit: null,
    totals: { probes: 0, passed: 0, failed: 0, costUsd: 0 },
    notes: [],
  };
}

function phaseArgument(): string {
  const arg = process.argv.find((value) => value.startsWith("--phase="));
  return arg === undefined ? "all" : (arg.split("=")[1] ?? "all");
}

function promptOf(words: number, nonce: string): string {
  return `D5 probe ${nonce}. ${"alpha ".repeat(words)}`;
}

function money(value: number): string {
  return `USD ${value.toFixed(6)}`;
}

interface Context {
  results: ResultsFile;
  crewToken: string;
  nightToken: string;
  secrets: string[];
  p1: { id: string; displayName: string; key: string };
  p2: { id: string; displayName: string; key: string };
  p3: { id: string; displayName: string; key: string };
  m2: { id: string; displayName: string; key: string };
  crewTeamId: string;
  nightTeamId: string;
}

async function buildContext(results: ResultsFile): Promise<Context> {
  const managerTokens = JSON.parse(readFileSync(MANAGER_TOKEN_FILE, "utf8")) as {
    crew?: string;
    night?: string;
  };
  const crewToken = managerTokens.crew ?? "";
  const nightToken = managerTokens.night ?? "";
  if (crewToken === "" || nightToken === "") {
    throw new Error("manager token file has no crew/night token");
  }
  const keys: Record<string, string> = {};
  for (const spec of MEMBERS) keys[spec.id] = readSecret(keyPath(spec.id));
  const secrets = [...Object.values(keys), crewToken, nightToken];

  const crew = await overview(crewToken, secrets);
  const night = await overview(nightToken, secrets);
  const byName = (name: string): { id: string; displayName: string } => {
    const found = [...crew.members, ...night.members].find((member) => member.displayName === name);
    if (found === undefined) throw new Error(`member ${name} not found`);
    return { id: found.id, displayName: found.displayName };
  };

  const p1 = byName("Ines");
  const p2 = byName("Rune");
  const p3 = byName("Vera");
  const m2 = byName("Nils");
  results.members = { p1: p1.id, p2: p2.id, p3: p3.id, m2: m2.id };

  return {
    results,
    crewToken,
    nightToken,
    secrets,
    p1: { ...p1, key: keys.p1 ?? "" },
    p2: { ...p2, key: keys.p2 ?? "" },
    p3: { ...p3, key: keys.p3 ?? "" },
    m2: { ...m2, key: keys.m2 ?? "" },
    crewTeamId: crew.teamId,
    nightTeamId: night.teamId,
  };
}

async function probeTokenCap(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const calls: GatewayCall[] = [];
  const checks: Check[] = [];
  const before = await memberDetail(context.crewToken, context.p1.id, context.secrets);
  const alreadyBlocked = before?.blocked ?? false;

  if (alreadyBlocked) {
    const unblocked = await api(`/api/team/members/${context.p1.id}/key/unblock`, {
      token: context.crewToken,
      method: "POST",
      body: {},
      secrets: context.secrets,
    });
    checks.push(
      makeCheck(
        "p1 starts unblocked",
        "the key is usable before the cap probe",
        `was blocked; unblock HTTP ${unblocked.status}`,
        unblocked.status === 200,
      ),
    );
    await waitForMember(
      context.crewToken,
      context.p1.id,
      context.secrets,
      (member) => !member.blocked,
      RECONCILE_WAIT_MS,
    );
  } else {
    checks.push(makeCheck("p1 starts unblocked", "the key is usable", "not blocked", true));
  }

  const callStart = Date.now();
  const first = await callModel(
    context.p1.key,
    MODEL,
    promptOf(2_000, "token-cap-1"),
    SMALL_MAX_TOKENS,
    context.secrets,
  );
  calls.push(first);
  const second = await callModel(
    context.p1.key,
    MODEL,
    promptOf(2_000, "token-cap-2"),
    SMALL_MAX_TOKENS,
    context.secrets,
  );
  calls.push(second);
  const afterCalls = Date.now();

  const blocked = await waitForMember(
    context.crewToken,
    context.p1.id,
    context.secrets,
    (member) => member.blocked,
    WAIT_TIMEOUT_MS,
  );
  const blockedWithinMs = blocked.member?.blocked === true ? blocked.elapsedMs : -1;
  const withinOnePoll = blockedWithinMs >= 0 && blockedWithinMs <= 30_000;

  const third = await callModel(context.p1.key, MODEL, "Say OK", TINY_MAX_TOKENS, context.secrets);
  calls.push(third);

  checks.push(
    makeCheck(
      "two calls succeed",
      "HTTP 200 for both calls",
      `${first.status}, ${second.status}`,
      first.ok && second.ok,
    ),
  );
  checks.push(
    makeCheck(
      "p1 key blocked by the watcher",
      "blocked within 30 s of the two calls",
      blocked.member?.blocked
        ? `blocked ${(blockedWithinMs / 1000).toFixed(1)} s after the first call`
        : `not blocked within ${(WAIT_TIMEOUT_MS / 1000).toFixed(0)} s`,
      blocked.member?.blocked === true && withinOnePoll,
    ),
  );
  checks.push(
    makeCheck(
      "third call refused",
      "a non-2xx gateway refusal",
      `HTTP ${third.status}${third.errorMessage === null ? "" : `: ${third.errorMessage}`}`,
      !third.ok,
    ),
  );

  const spend = await gatewaySpend(
    calls.filter((call) => call.ok && call.requestId !== null).map((call) => call.requestId ?? ""),
    context.results.runStartedAt,
  );

  return {
    id: "1-token-cap",
    title: "Token cap (p1)",
    expected:
      "Two calls succeed; the watcher blocks p1's key within one poll interval; the third call is refused.",
    observed: `Calls: ${first.status}, ${second.status}, ${third.status}. Watcher blocked: ${blocked.member?.blocked === true ? "yes" : "no"} (${blockedWithinMs >= 0 ? `${(blockedWithinMs / 1000).toFixed(1)} s` : "timed out"}). Costs ${money(spend.totalUsd)} over ${spend.found} logged calls; calls finished ${afterCalls - callStart} ms after the first.`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: spend.totalUsd,
    checks,
    evidence: {
      callStatuses: [first.status, second.status, third.status],
      blockedWithinMs,
      tokenCounts: calls.map((call) => ({
        prompt: call.promptTokens,
        completion: call.completionTokens,
      })),
      spendRows: spend.rows,
    },
  };
}

async function probeKeyOperations(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const checks: Check[] = [];
  const calls: GatewayCall[] = [];

  const before = await callModel(context.p2.key, MODEL, "Say OK", TINY_MAX_TOKENS, context.secrets);
  calls.push(before);
  checks.push(makeCheck("p2 key works", "HTTP 200", `HTTP ${before.status}`, before.ok));

  const block = await api(`/api/team/members/${context.p2.id}/key/block`, {
    token: context.crewToken,
    method: "POST",
    body: { reason: "D5 probe: key block" },
    secrets: context.secrets,
  });
  const blocked = await waitForMember(
    context.crewToken,
    context.p2.id,
    context.secrets,
    (member) => member.blocked,
    RECONCILE_WAIT_MS,
  );
  const blockedCall = await callModel(
    context.p2.key,
    MODEL,
    "Say OK",
    TINY_MAX_TOKENS,
    context.secrets,
  );
  calls.push(blockedCall);
  checks.push(
    makeCheck(
      "manager block",
      "block HTTP 200, member blocked, key refused",
      `block ${block.status}; blocked ${blocked.member?.blocked === true}; call ${blockedCall.status}`,
      block.status === 200 && blocked.member?.blocked === true && !blockedCall.ok,
    ),
  );

  const unblock = await api(`/api/team/members/${context.p2.id}/key/unblock`, {
    token: context.crewToken,
    method: "POST",
    body: {},
    secrets: context.secrets,
  });
  const released = await waitForMember(
    context.crewToken,
    context.p2.id,
    context.secrets,
    (member) => !member.blocked,
    RECONCILE_WAIT_MS,
  );
  const unblockedCall = await callModel(
    context.p2.key,
    MODEL,
    "Say OK",
    TINY_MAX_TOKENS,
    context.secrets,
  );
  calls.push(unblockedCall);
  checks.push(
    makeCheck(
      "manager unblock",
      "unblock HTTP 200, member unblocked, key works",
      `unblock ${unblock.status}; unblocked ${released.member?.blocked === false}; call ${unblockedCall.status}`,
      unblock.status === 200 && released.member?.blocked === false && unblockedCall.ok,
    ),
  );

  const rotate = await api(`/api/team/members/${context.p2.id}/key/rotate`, {
    token: context.crewToken,
    method: "POST",
    body: {},
    secrets: context.secrets,
  });
  const rotatedSecret = str(obj(rotate.body).secret) ?? "";
  if (rotate.status === 200 && rotatedSecret !== "") {
    writeFileSync(keyPath("p2"), `${rotatedSecret}\n`, { mode: 0o600 });
    context.secrets.push(rotatedSecret);
  }
  const oldCall = await callModel(
    context.p2.key,
    MODEL,
    "Say OK",
    TINY_MAX_TOKENS,
    context.secrets,
  );
  calls.push(oldCall);
  const newCall =
    rotatedSecret === ""
      ? null
      : await callModel(rotatedSecret, MODEL, "Say OK", TINY_MAX_TOKENS, context.secrets);
  if (newCall !== null) calls.push(newCall);
  if (rotatedSecret !== "") context.p2.key = rotatedSecret;
  checks.push(
    makeCheck(
      "manager rotate",
      "rotate HTTP 200, old key refused, new key works",
      `rotate ${rotate.status}; old key ${oldCall.status}; new key ${newCall === null ? "missing" : String(newCall.status)}`,
      rotate.status === 200 && rotatedSecret !== "" && !oldCall.ok && newCall?.ok === true,
    ),
  );

  const spend = await gatewaySpend(
    calls.filter((call) => call.ok && call.requestId !== null).map((call) => call.requestId ?? ""),
    context.results.runStartedAt,
  );

  return {
    id: "2-key-operations",
    title: "Key operations (p2)",
    expected: "Block refuses, unblock works, rotate refuses the old key and the new key works.",
    observed: `block ${block.status}/${blockedCall.status}, unblock ${unblock.status}/${unblockedCall.status}, rotate ${rotate.status}; old ${oldCall.status}, new ${newCall?.status ?? "missing"}. Cost ${money(spend.totalUsd)}.`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: spend.totalUsd,
    checks,
    evidence: {
      callStatuses: calls.map((call) => call.status),
      rotated: rotatedSecret !== "",
      spendRows: spend.rows,
    },
  };
}

async function probeFlagship(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const checks: Check[] = [];
  const calls: GatewayCall[] = [];
  const notes: string[] = [];

  let approvalAt: string | null = null;
  let expiresAt: string | null = null;
  let requestId: string | null = null;
  let grantId: string | null = null;
  let reissued = false;

  const immediate = await memberDetail(context.crewToken, context.m2.id, context.secrets);
  const activeGrant = immediate?.grants.find((grant) => {
    if (grant.scope !== "model" || grant.modelId !== FLAGSHIP) return false;
    if (grant.revokedAt !== null || grant.expiresAt === null) return false;
    return Date.parse(grant.expiresAt) > Date.now();
  });

  if (activeGrant !== undefined) {
    approvalAt = activeGrant.startsAt;
    expiresAt = activeGrant.expiresAt;
    grantId = activeGrant.id;
    notes.push("used the leader's active flagship grant from the team test");
  } else {
    // The earlier grant can expire before this probe runs. Re-issue the same
    // fixed-rule decision through the leader token so the probe can observe
    // the full unlock → expiry cycle; the request stays in the audit trail.
    const created = await api("/api/me/requests", {
      token: context.m2.key,
      method: "POST",
      body: {
        kind: "model_unlock",
        modelId: FLAGSHIP,
        message:
          "D5 probe: re-verify the 15-minute flagship unlock after the earlier grant expired; one tiny call, then expiry.",
      },
      secrets: context.secrets,
    });
    requestId = str(obj(created.body).id);
    const until = new Date(Date.now() + EXPIRY_MS).toISOString();
    if (requestId !== null) {
      const decided = await api(`/api/team/requests/${requestId}/decide`, {
        token: context.crewToken,
        method: "POST",
        body: {
          outcome: "approved",
          note: "D5 probe: approved for 15 minutes to observe the unlock and its expiry",
          until,
        },
        secrets: context.secrets,
      });
      if (decided.status === 200) {
        const grant = obj(obj(decided.body).grant);
        grantId = str(grant.id);
        approvalAt = str(grant.startsAt) ?? nowIso();
        expiresAt = str(grant.expiresAt) ?? until;
        reissued = true;
        notes.push("re-issued the leader's fixed-rule approval because the D2 window had expired");
      }
      checks.push(
        makeCheck(
          "leader approval",
          "HTTP 200 with an active 15-minute grant",
          `request ${created.status}, decision ${decided.status}, grant ${grantId ?? "missing"}`,
          created.status === 201 && decided.status === 200 && grantId !== null,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          "leader approval",
          "a model-unlock request and a 15-minute grant",
          `request creation HTTP ${created.status}`,
          false,
        ),
      );
    }
  }

  const unlocked = await waitForMember(
    context.crewToken,
    context.m2.id,
    context.secrets,
    (member) => member.allowedModels.includes(FLAGSHIP),
    RECONCILE_WAIT_MS,
  );
  checks.push(
    makeCheck(
      "flagship allowed after approval",
      "flagship is in the key's model allowlist",
      unlocked.member?.allowedModels.includes(FLAGSHIP) === true
        ? "flagship is allowed"
        : `allowed models: ${unlocked.member?.allowedModels.join(", ") ?? "unknown"}`,
      unlocked.member?.allowedModels.includes(FLAGSHIP) === true,
    ),
  );

  const unlockedCall = await callModel(
    context.m2.key,
    FLAGSHIP,
    "Say OK",
    TINY_MAX_TOKENS,
    context.secrets,
  );
  calls.push(unlockedCall);
  checks.push(
    makeCheck(
      "flagship call works",
      "HTTP 200 with the active grant",
      `HTTP ${unlockedCall.status}${unlockedCall.errorMessage === null ? "" : `: ${unlockedCall.errorMessage}`}`,
      unlockedCall.ok,
    ),
  );

  let expiryObservedAt: string | null = null;
  let expiredCall: GatewayCall | null = null;
  const expiryMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  if (unlockedCall.ok && expiresAt !== null && Number.isFinite(expiryMs)) {
    const waitUntil = expiryMs + RECONCILE_WAIT_MS + 5_000;
    const waitMs = Math.max(0, waitUntil - Date.now());
    log(
      `waiting ${(waitMs / 60_000).toFixed(1)} min for the grant expiry and one reconciler cycle`,
    );
    await sleep(waitMs);
    const reverted = await waitForMember(
      context.crewToken,
      context.m2.id,
      context.secrets,
      (member) => !member.allowedModels.includes(FLAGSHIP),
      WAIT_TIMEOUT_MS,
    );
    expiryObservedAt = nowIso();
    expiredCall = await callModel(
      context.m2.key,
      FLAGSHIP,
      "Say OK",
      TINY_MAX_TOKENS,
      context.secrets,
    );
    calls.push(expiredCall);
    checks.push(
      makeCheck(
        "grant expiry removes the model",
        "flagship leaves the allowlist after expiry plus one reconciler cycle",
        reverted.member?.allowedModels.includes(FLAGSHIP) === false
          ? `removed; expiresAt ${expiresAt}`
          : `still allowed at ${nowIso()}`,
        reverted.member?.allowedModels.includes(FLAGSHIP) === false,
      ),
    );
    checks.push(
      makeCheck(
        "flagship call refused after expiry",
        "a non-2xx gateway refusal",
        `HTTP ${expiredCall.status}${expiredCall.errorMessage === null ? "" : `: ${expiredCall.errorMessage}`}`,
        !expiredCall.ok,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "grant expiry removes the model",
        "flagship leaves the allowlist after expiry plus one reconciler cycle",
        "skipped because the unlocked call did not succeed",
        false,
      ),
    );
  }

  const spend = await gatewaySpend(
    calls.filter((call) => call.ok && call.requestId !== null).map((call) => call.requestId ?? ""),
    context.results.runStartedAt,
  );

  return {
    id: "3-flagship-unlock",
    title: "m2's flagship unlock and expiry",
    expected:
      "After the leader's 15-minute approval, one tiny flagship call works; after expiry plus one reconciler cycle the same call is refused.",
    observed: `${notes.join("; ")}. approval ${approvalAt ?? "missing"}, expires ${expiresAt ?? "missing"}, expiry observed ${expiryObservedAt ?? "not reached"}. Flagship call ${unlockedCall.status}; after expiry ${expiredCall?.status ?? "not run"}. Cost ${money(spend.totalUsd)}.${requestId === null ? "" : ` Request ${requestId}.`}${grantId === null ? "" : ` Grant ${grantId}.`}`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: spend.totalUsd,
    checks,
    evidence: {
      approvalAt,
      expiresAt,
      expiryObservedAt,
      requestId,
      grantId,
      reissued,
      callStatuses: calls.map((call) => call.status),
      spendRows: spend.rows,
    },
  };
}

async function probeRequestHandling(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const checks: Check[] = [];

  const cancelRequest = await api("/api/me/requests", {
    token: context.p2.key,
    method: "POST",
    // Above the team's USD 0.01 auto-approve rule, so the request stays
    // pending and the member can cancel it.
    body: { kind: "more_budget", amountUsd: 0.02, message: "D5 probe: request to cancel" },
    secrets: context.secrets,
  });
  const cancelId = str(obj(cancelRequest.body).id);
  const cancelled =
    cancelId === null
      ? null
      : await api(`/api/me/requests/${cancelId}/cancel`, {
          token: context.p2.key,
          method: "POST",
          body: {},
          secrets: context.secrets,
        });
  checks.push(
    makeCheck(
      "member cancels its own request",
      "create 201, cancel 200, state cancelled",
      `create ${cancelRequest.status}, cancel ${cancelled?.status ?? "missing"}, state ${str(obj(cancelled?.body).state) ?? "missing"}`,
      cancelRequest.status === 201 &&
        cancelled?.status === 200 &&
        str(obj(cancelled.body).state) === "cancelled",
    ),
  );

  const suggestion = await api("/api/me/requests", {
    token: context.p2.key,
    method: "POST",
    body: { kind: "suggestion", message: "D5 probe: suggestion to note" },
    secrets: context.secrets,
  });
  const suggestionId = str(obj(suggestion.body).id);
  const noted =
    suggestionId === null
      ? null
      : await api(`/api/team/requests/${suggestionId}/decide`, {
          token: context.crewToken,
          method: "POST",
          body: { outcome: "approved", note: "noted" },
          secrets: context.secrets,
        });
  checks.push(
    makeCheck(
      "suggestion is noted",
      "create 201, decision 200, state approved with note noted",
      `create ${suggestion.status}, decide ${noted?.status ?? "missing"}, state ${str(obj(obj(noted?.body).request).state) ?? "missing"}`,
      suggestion.status === 201 &&
        noted?.status === 200 &&
        str(obj(obj(noted?.body).request).state) === "approved" &&
        str(obj(obj(noted?.body).decision).note) === "noted",
    ),
  );

  const memberOnManager = await api("/api/team/members", {
    token: context.p2.key,
    secrets: context.secrets,
  });
  checks.push(
    makeCheck(
      "member key on a manager endpoint",
      "HTTP 403",
      `HTTP ${memberOnManager.status}`,
      memberOnManager.status === 403,
    ),
  );

  const nightOnNight = await api(`/api/team/members?teamId=${context.nightTeamId}`, {
    token: context.nightToken,
    secrets: context.secrets,
  });
  const nightIds = arr(nightOnNight.body).map((row) => str(obj(row).id) ?? "");
  checks.push(
    makeCheck(
      "Night manager acts on Night",
      "HTTP 200 and p3 is listed",
      `HTTP ${nightOnNight.status}, p3 listed ${nightIds.includes(context.p3.id)}`,
      nightOnNight.status === 200 && nightIds.includes(context.p3.id),
    ),
  );

  const crewOnNight = await api(`/api/team/members?teamId=${context.nightTeamId}`, {
    token: context.crewToken,
    secrets: context.secrets,
  });
  checks.push(
    makeCheck(
      "Crew manager acts on Night",
      "HTTP 403",
      `HTTP ${crewOnNight.status}`,
      crewOnNight.status === 403,
    ),
  );

  const p3OnCrew = await api(`/api/team/members?teamId=${context.crewTeamId}`, {
    token: context.p3.key,
    secrets: context.secrets,
  });
  checks.push(
    makeCheck(
      "p3 member key on Crew",
      "HTTP 403",
      `HTTP ${p3OnCrew.status}`,
      p3OnCrew.status === 403,
    ),
  );

  return {
    id: "4-request-handling",
    title: "Request handling (p2, p3, Night)",
    expected:
      "p2 cancels its own request; a suggestion is noted; a member key on a manager endpoint is refused; the Night manager acts on Night while p3's member key on Crew is refused.",
    observed: `cancel ${cancelRequest.status}/${cancelled?.status ?? "missing"}, suggestion ${suggestion.status}/${noted?.status ?? "missing"}, member→manager ${memberOnManager.status}, Night manager→Night ${nightOnNight.status}, Crew manager→Night ${crewOnNight.status}, p3→Crew ${p3OnCrew.status}.`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: 0,
    checks,
    evidence: {
      cancelledRequestId: cancelId,
      suggestionRequestId: suggestionId,
      statuses: {
        create: cancelRequest.status,
        cancel: cancelled?.status ?? null,
        suggestion: suggestion.status,
        decision: noted?.status ?? null,
        memberOnManager: memberOnManager.status,
        nightOnNight: nightOnNight.status,
        crewOnNight: crewOnNight.status,
        p3OnCrew: p3OnCrew.status,
      },
    },
  };
}

async function probeBlockedModel(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const call = await callModel(
    context.p2.key,
    BLOCKED_MODEL,
    "Say OK",
    TINY_MAX_TOKENS,
    context.secrets,
  );
  const readable =
    call.errorMessage !== null &&
    call.errorMessage.length > 10 &&
    call.errorMessage.toLowerCase().includes("model");
  const checks = [
    makeCheck(
      "blocked-model is refused",
      "a non-2xx gateway refusal",
      `HTTP ${call.status}`,
      !call.ok,
    ),
    makeCheck(
      "refusal message is readable",
      "a message naming the model refusal",
      call.errorMessage ?? "no message",
      readable,
    ),
  ];

  return {
    id: "5-blocked-model",
    title: "Blocked model (p2)",
    expected: "A blocked-model call is refused with a readable message.",
    observed: `HTTP ${call.status}: ${call.errorMessage ?? "no message"}`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: 0,
    checks,
    evidence: {
      status: call.status,
      errorType: call.errorType,
      errorMessage: call.errorMessage,
    },
  };
}

interface ExpectedNotice {
  key: string;
  kind: string;
  audience: "manager" | "member";
  memberId: string;
  memberName: string;
  subject: string;
  label: string;
}

async function probeNotifications(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const checks: Check[] = [];
  const calls: GatewayCall[] = [];
  const notes: string[] = [];

  const baselineAt = context.results.runStartedAt;

  const startingDetail = await memberDetail(context.crewToken, context.p2.id, context.secrets);
  const startingSpend = await memberSpend(context.crewToken, context.p2.id, context.secrets);
  const nowMs = Date.now();
  const budgetGrantUsd = (startingDetail?.grants ?? [])
    .filter(
      (grant) =>
        grant.scope === "budget" &&
        grant.revokedAt === null &&
        (grant.expiresAt === null || Date.parse(grant.expiresAt) > nowMs),
    )
    .reduce((sum, grant) => sum + (grant.amountUsd ?? 0), 0);
  // Budgets are rounded to whole cents by the policy. Pick the next cent above
  // current spend and cross it with a few small calls, staying under the hard
  // limit (budget + 30% grace).
  const targetEffectiveUsd = Math.max(0.01, Math.ceil((startingSpend + 0.0005) * 100) / 100);
  const baseBudgetUsd = Math.max(0, Math.round((targetEffectiveUsd - budgetGrantUsd) * 100) / 100);
  const targetSpendUsd = targetEffectiveUsd + 0.0005;
  const thresholdCalls = Math.min(
    30,
    Math.max(2, Math.ceil((targetSpendUsd - startingSpend) / 0.000775)),
  );
  const priorBudgetUpdates = (
    await auditEvents(context.crewToken, context.results.runStartedAt, context.secrets)
  ).filter((event) => event.action === "limits.updated" && event.objectId === context.p2.id).length;
  notes.push(
    `p2 starts at status ${startingDetail?.status ?? "unknown"} with ${money(startingSpend)} spent, ` +
      `${money(budgetGrantUsd)} active budget grants, a ${money(targetEffectiveUsd)} effective budget ` +
      `and ${thresholdCalls} threshold calls`,
  );

  const lower = await api(`/api/team/members/${context.p2.id}/limits`, {
    token: context.crewToken,
    method: "PATCH",
    body: { budgetUsd: baseBudgetUsd },
    secrets: context.secrets,
  });
  checks.push(
    makeCheck(
      "lower p2 budget for threshold notices",
      "PATCH limits HTTP 200",
      `HTTP ${lower.status}`,
      lower.status === 200,
    ),
  );
  await sleep(RECONCILE_WAIT_MS);

  for (let index = 1; index <= thresholdCalls; index += 1) {
    const call = await callModel(
      context.p2.key,
      MODEL,
      promptOf(1_500, `threshold-${index}`),
      SMALL_MAX_TOKENS,
      context.secrets,
    );
    calls.push(call);
    // The policy floors the hard budget to whole cents, so the last planned
    // call can legitimately hit the gateway stop just after the threshold.
    if (!call.ok) break;
  }

  // The watcher polls every few seconds; let it see the low budget before the
  // budget is restored.
  await sleep(15_000);

  const raised = await api(`/api/team/members/${context.p2.id}/limits`, {
    token: context.crewToken,
    method: "PATCH",
    body: { budgetUsd: 0.05 },
    secrets: context.secrets,
  });
  checks.push(
    makeCheck(
      "restore p2 budget",
      "PATCH limits HTTP 200",
      `HTTP ${raised.status}`,
      raised.status === 200,
    ),
  );
  await sleep(RECONCILE_WAIT_MS);

  // Unusual spend is once per member per day; a rerun finds the notice that
  // the earlier run already delivered.
  if (startingSpend <= 0.01) {
    const unusualCall = await callModel(
      context.p2.key,
      MODEL,
      promptOf(22_000, "unusual-spend"),
      SMALL_MAX_TOKENS,
      context.secrets,
    );
    calls.push(unusualCall);
    checks.push(
      makeCheck(
        "unusual-spend call succeeds",
        "HTTP 200",
        `HTTP ${unusualCall.status}`,
        unusualCall.ok,
      ),
    );
  } else {
    notes.push(
      "unusual-spend notice was already due from the earlier spend, so no extra call was made",
    );
  }

  const succeededCalls = calls.filter((call) => call.ok).length;
  checks.push(
    makeCheck(
      "threshold spend was generated",
      "at least one small call succeeds (the budget may stop the last one)",
      `${succeededCalls} of ${calls.length} calls succeeded: ${calls.map((call) => String(call.status)).join(", ")}`,
      succeededCalls >= 1,
    ),
  );

  const budgetUpdates =
    priorBudgetUpdates + (lower.status === 200 ? 1 : 0) + (raised.status === 200 ? 1 : 0);

  // Give the watcher time to poll the spend and fan out both channels.
  await sleep(20_000);

  const expected: ExpectedNotice[] = [
    {
      key: "request_created",
      kind: "request_created",
      audience: "manager",
      memberId: context.p2.id,
      memberName: context.p2.displayName,
      subject: "New request",
      label: "new request (manager)",
    },
    {
      key: "request_decided",
      kind: "request_decided",
      audience: "member",
      memberId: context.p2.id,
      memberName: context.p2.displayName,
      subject: "Decision",
      label: "decision (member)",
    },
    {
      key: "soft_limit",
      kind: "soft_limit",
      audience: "member",
      memberId: context.p2.id,
      memberName: context.p2.displayName,
      subject: "[team-ai-allowance] Soft limit reached",
      label: "soft limit (member)",
    },
    {
      key: "grace",
      kind: "grace",
      audience: "member",
      memberId: context.p2.id,
      memberName: context.p2.displayName,
      subject: "[team-ai-allowance] Budget reached: grace period",
      label: "grace (member)",
    },
    {
      key: "member_blocked_manager",
      kind: "member_blocked",
      audience: "manager",
      memberId: context.p1.id,
      memberName: context.p1.displayName,
      subject: `[team-ai-allowance] Token cap reached: ${context.p1.displayName}`,
      label: "blocked (manager)",
    },
    {
      key: "member_blocked_member",
      kind: "member_blocked",
      audience: "member",
      memberId: context.p1.id,
      memberName: context.p1.displayName,
      subject: "[team-ai-allowance] Your token cap is reached",
      label: "blocked (member)",
    },
    {
      key: "unusual_spend",
      kind: "unusual_spend",
      audience: "manager",
      memberId: context.p2.id,
      memberName: context.p2.displayName,
      subject: `[team-ai-allowance] Unusual spend: ${context.p2.displayName}`,
      label: "unusual spend (manager)",
    },
  ];

  const webhook = (await webhookEvents()).filter((event) => event.at >= baselineAt);
  const mail = (await mailMessages()).filter((message) => message.created >= baselineAt);

  const observed: Array<Record<string, unknown>> = [];
  for (const notice of expected) {
    const webhookMatches = webhook.filter((event) => {
      const payload = event.payload;
      return (
        str(payload.kind) === notice.kind &&
        str(payload.audience) === notice.audience &&
        str(payload.memberId) === notice.memberId
      );
    });
    const mailMatches = mail.filter((message) => {
      const namesMember =
        message.body.includes(notice.memberName) || notice.subject.includes(notice.memberName);
      if (!namesMember) return false;
      if (notice.kind === "request_created") {
        return message.subject.toLowerCase().includes("request");
      }
      if (notice.kind === "request_decided") {
        return message.subject.toLowerCase().includes("decid");
      }
      return message.subject === notice.subject;
    });
    const pass = webhookMatches.length === 1 && mailMatches.length === 1;
    observed.push({
      notice: notice.label,
      kind: notice.kind,
      audience: notice.audience,
      webhook: webhookMatches.length,
      mail: mailMatches.length,
      dedupeKeys: webhookMatches.map((event) => str(event.payload.dedupeKey)),
      pass,
    });
    checks.push(
      makeCheck(
        notice.label,
        `exactly once on the webhook and in the mail catcher`,
        `webhook ${webhookMatches.length}, mail ${mailMatches.length}`,
        pass,
      ),
    );
  }

  const spend = await gatewaySpend(
    calls.filter((call) => call.ok && call.requestId !== null).map((call) => call.requestId ?? ""),
    context.results.runStartedAt,
  );

  const actualCount = observed.filter((item) => item.pass === true).length;
  return {
    id: "6-notifications",
    title: "Notifications (webhook and mail)",
    expected:
      "Each expected notice appears exactly once on the webhook and in the mail catcher: new request, decision, soft limit, grace, blocked, unusual spend.",
    observed: `${actualCount} of ${expected.length} expected notices appeared exactly once on both channels; webhook events since run start: ${webhook.length}, new mail messages: ${mail.length}. Costs ${money(spend.totalUsd)}. ${notes.join("; ")}`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: spend.totalUsd,
    checks,
    evidence: {
      notices: observed,
      webhookCount: webhook.length,
      mailCount: mail.length,
      callStatuses: calls.map((call) => call.status),
      budgetUpdates,
      spendRows: spend.rows,
    },
  };
}

async function probeAudit(context: Context): Promise<ProbeRecord> {
  const startedAt = nowIso();
  const checks: Check[] = [];
  const events = await auditEvents(
    context.crewToken,
    context.results.runStartedAt,
    context.secrets,
  );
  const byId = (id: string): ProbeRecord | undefined =>
    context.results.probes.find((probe) => probe.id === id);

  const p2Requests = byId("4-request-handling");
  const cancelledRequestId = str(obj(p2Requests?.evidence).cancelledRequestId) ?? null;
  const suggestionRequestId = str(obj(p2Requests?.evidence).suggestionRequestId) ?? null;
  const flagship = byId("3-flagship-unlock");

  const expected: Array<{ label: string; action: string; objectId: string; count: number }> = [
    {
      label: "p1 token-cap block",
      action: "watcher.token_cap_block",
      objectId: context.p1.id,
      count: 1,
    },
    { label: "p2 key block", action: "member.blocked", objectId: context.p2.id, count: 1 },
    { label: "p2 key unblock", action: "member.unblocked", objectId: context.p2.id, count: 1 },
    { label: "p2 key rotation", action: "key.rotated", objectId: context.p2.id, count: 1 },
  ];
  const notificationProbe = byId("6-notifications");
  const budgetUpdates = num(obj(notificationProbe?.evidence).budgetUpdates);
  if (budgetUpdates !== null && budgetUpdates > 0) {
    expected.push({
      label: "p2 budget updates",
      action: "limits.updated",
      objectId: context.p2.id,
      count: budgetUpdates,
    });
  }
  if (cancelledRequestId !== null) {
    expected.push({
      label: "cancelled request creation",
      action: "request.created",
      objectId: cancelledRequestId,
      count: 1,
    });
    expected.push({
      label: "member cancellation",
      action: "request.cancelled",
      objectId: cancelledRequestId,
      count: 1,
    });
  }
  if (suggestionRequestId !== null) {
    expected.push({
      label: "suggestion creation",
      action: "request.created",
      objectId: suggestionRequestId,
      count: 1,
    });
    expected.push({
      label: "suggestion decision",
      action: "request.decided",
      objectId: suggestionRequestId,
      count: 1,
    });
  }
  if (flagship !== undefined) {
    const evidence = obj(flagship.evidence);
    const requestId = str(evidence.requestId);
    const grantId = str(evidence.grantId);
    const reissued = bool(evidence.reissued) === true;
    if (reissued && requestId !== null) {
      expected.push({
        label: "flagship request creation",
        action: "request.created",
        objectId: requestId,
        count: 1,
      });
      expected.push({
        label: "flagship request decision",
        action: "request.decided",
        objectId: requestId,
        count: 1,
      });
    }
    if (grantId !== null) {
      if (reissued) {
        expected.push({
          label: "grant issued",
          action: "grant.issued",
          objectId: grantId,
          count: 1,
        });
      }
      expected.push({
        label: "grant expired",
        action: "grant.expired",
        objectId: grantId,
        count: 1,
      });
    }
  }

  for (const item of expected) {
    const matches = countEvents(events, item.action, item.objectId);
    const stored = storeAuditCount(item.action, item.objectId);
    checks.push(
      makeCheck(
        item.label,
        `${item.count} audit event${item.count === 1 ? "" : "s"} (${item.action})`,
        `${matches.length} through the team API, ${stored} in the store`,
        matches.length === item.count && stored === item.count,
      ),
    );
  }

  // Every notice actually delivered must have exactly one notification.sent
  // row, keyed by the notification's dedupe key.
  const noticeIds = (() => {
    const probe = byId("6-notifications");
    return arr(obj(probe?.evidence).notices)
      .flatMap((item) => arr(obj(item).dedupeKeys))
      .map((value) => str(value))
      .filter((value): value is string => value !== null);
  })();
  let storeNotices = 0;
  let apiNotices = 0;
  for (const dedupeKey of noticeIds) {
    const stored = storeAuditCount("notification.sent", dedupeKey);
    const api = countEvents(events, "notification.sent", dedupeKey).length;
    storeNotices += stored;
    apiNotices += api;
    checks.push(
      makeCheck(
        `notice audit row ${dedupeKey.split(":").slice(0, 2).join(":")}`,
        "exactly one notification.sent event in the audit store",
        `${stored} in the store, ${api} through the team API`,
        stored === 1,
      ),
    );
  }
  checks.push(
    makeCheck(
      "delivered notices reachable through the team audit API",
      `${noticeIds.length} notification.sent rows`,
      `${apiNotices} of ${noticeIds.length} visible (${storeNotices} in the store)`,
      noticeIds.length > 0 && apiNotices === noticeIds.length,
    ),
  );

  const failedUpdates = events.filter((event) => event.action === "key.state_failed");
  checks.push(
    makeCheck(
      "no failed key update during the probes",
      "no key.state_failed event",
      `${failedUpdates.length} failed update${failedUpdates.length === 1 ? "" : "s"}`,
      failedUpdates.length === 0,
    ),
  );

  return {
    id: "7-audit-completeness",
    title: "Audit completeness",
    expected: "Every state-changing probe action appears exactly once in the audit log.",
    observed: `${events.length} audit events since ${context.results.runStartedAt}; ${checks.filter((check) => check.pass).length}/${checks.length} checks passed.`,
    pass: checks.every((check) => check.pass),
    startedAt,
    finishedAt: nowIso(),
    costUsd: 0,
    checks,
    evidence: {
      auditEventCount: events.length,
      expectedActions: expected,
      noticeDedupeKeys: noticeIds,
      noticesInStore: storeNotices,
      noticesInTeamApi: apiNotices,
      failedUpdates: failedUpdates.length,
    },
  };
}

async function main(): Promise<number> {
  const phase = phaseArgument();
  const existing = loadResults();
  const results = phase === "all" || existing === null ? freshResults() : existing;
  if (phase === "all") writeResults(results);

  const context = await buildContext(results);
  log(
    `phase ${phase}; p1=${context.p1.id} p2=${context.p2.id} p3=${context.p3.id} m2=${context.m2.id}`,
  );

  if (phase === "all" || phase === "core") {
    upsertProbe(results, await probeTokenCap(context));
    upsertProbe(results, await probeKeyOperations(context));
    upsertProbe(results, await probeRequestHandling(context));
    upsertProbe(results, await probeBlockedModel(context));
    log("core probes recorded");
  }

  if (phase === "request") {
    upsertProbe(results, await probeRequestHandling(context));
    log("request-handling probe recorded");
  }

  if (phase === "all" || phase === "flagship") {
    upsertProbe(results, await probeFlagship(context));
    log("flagship probe recorded");
  }

  if (phase === "all" || phase === "notify") {
    upsertProbe(results, await probeNotifications(context));
    log("notification probe recorded");
  }

  if (phase === "all" || phase === "audit") {
    upsertProbe(results, await probeAudit(context));
    await reconcileCosts(context);
    results.status = "complete";
    writeResults(results);
    log("audit probe recorded; results complete");
  }

  writeResults(results);
  const failed = results.probes.filter((probe) => !probe.pass);
  log(
    `recorded ${results.probes.length} probes: ${results.totals.passed} pass, ${results.totals.failed} fail, cost ${money(results.totals.costUsd)}`,
  );
  for (const probe of failed) log(`FAIL ${probe.id}: ${probe.observed}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`failed: ${describeError(error)}`);
    process.exitCode = 1;
  });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
