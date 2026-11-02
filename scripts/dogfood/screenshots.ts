/**
 * Console screenshots of the real team-test state.
 *
 * The Leader console passwords were generated randomly during setup and kept only in
 * the control process's memory, so they cannot be recovered after a restart.
 * This script therefore creates one temporary manager per test team through
 * the admin API, signs in as that manager, captures the pages, and leaves the
 * accounts for the cleanup step to delete with their teams. Nothing is printed;
 * the temporary password lives only in this process.
 *
 * For each page: 1280x900 and 360x800, light and dark, written to
 * `results/dogfood/`, with `results/dogfood/screenshots.json` as the manifest.
 *
 * Usage: node scripts/dogfood/screenshots.ts
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import {
  ADMIN_ENV_FILE,
  CONTROL_URL,
  MEMBERS_FILE,
  ROOT,
  TEAM_CREW,
  TEAM_NIGHT,
} from "./config.ts";
import { readEnvFile } from "./env.ts";

const OUT_DIR = join(ROOT, "results", "dogfood");
const MANIFEST = join(OUT_DIR, "screenshots.json");
const AUDIT_TO = "2026-11-02T08:35:00.000Z";
const TEMP_NAME = "D6 Console";

interface Session {
  cookie: string;
  csrf: string;
}

interface PageShot {
  file: string;
  page: string;
  team: string;
  width: number;
  theme: "light" | "dark";
  url: string;
  title: string;
  capturedAt: string;
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} dogfood-screenshots: ${line}\n`);
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

function cookiesOf(response: Response): string[] {
  return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0] ?? "");
}

async function apiLogin(email: string, password: string): Promise<Session> {
  const csrfResponse = await fetch(`${CONTROL_URL}/api/auth/csrf`);
  const csrf = str(obj(await csrfResponse.json()).csrfToken) ?? "";
  const csrfCookies = cookiesOf(csrfResponse);
  const login = await fetch(`${CONTROL_URL}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookies.join("; "),
    },
    body: new URLSearchParams({ email, password, _csrf: csrf }).toString(),
  });
  if (login.status < 300 || login.status >= 400) {
    throw new Error(`admin login failed: HTTP ${login.status}`);
  }
  const cookie = [...csrfCookies, ...cookiesOf(login)].join("; ");
  const session = await fetch(`${CONTROL_URL}/api/session`, { headers: { cookie } });
  const body = obj(await session.json());
  const token = str(body.csrfToken);
  if (!session.ok || token === null || token === "") throw new Error("admin session failed");
  return { cookie, csrf: token };
}

async function adminApi(
  session: Session,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    redirect: "manual",
    headers: {
      cookie: session.cookie,
      ...(method === "GET" ? {} : { "x-csrf-token": session.csrf }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return body === "" ? null : JSON.parse(body);
}

async function teamId(session: Session, name: string): Promise<string> {
  const teams = arr(await adminApi(session, "/api/admin/teams"));
  for (const entry of teams) {
    const team = obj(entry);
    if (str(team.name) === name) {
      const id = str(team.id);
      if (id !== null) return id;
    }
  }
  throw new Error(`team ${name} not found`);
}

/** Remove earlier temporary managers so a rerun starts clean. */
async function removeTemporaryManagers(session: Session, team: string): Promise<void> {
  const members = arr(await adminApi(session, `/api/team/members?teamId=${team}`));
  for (const entry of members) {
    const member = obj(entry);
    if (str(member.displayName) !== TEMP_NAME) continue;
    const id = str(member.id);
    if (id === null) continue;
    await adminApi(session, `/api/admin/teams/${team}/members/${id}`, { method: "DELETE" });
    log(`removed an earlier ${TEMP_NAME} account from a test team`);
  }
}

async function createTemporaryManager(
  session: Session,
  team: string,
  teamName: string,
): Promise<{ email: string; password: string }> {
  const email = `d6-console-${teamName.toLowerCase()}@example.test`;
  const password = `d6-${randomBytes(18).toString("hex")}`;
  await adminApi(session, `/api/admin/teams/${team}/members`, {
    method: "POST",
    body: { displayName: TEMP_NAME, role: "manager", email, password },
  });
  log(`created a temporary console manager in ${teamName} (password not printed)`);
  return { email, password };
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });
  const admin = readEnvFile(ADMIN_ENV_FILE);
  const email = admin.TAA_BOOTSTRAP_EMAIL;
  const password = admin.TAA_BOOTSTRAP_PASSWORD;
  if (email === undefined || password === undefined) {
    throw new Error("admin credentials are missing; run the dogfood stack first");
  }
  const repos = JSON.parse(readFileSync(MEMBERS_FILE, "utf8")) as Record<string, string>;
  const m1 = repos["dogfood-m1"];
  if (m1 === undefined) throw new Error("members.json has no dogfood-m1 entry");

  const adminSession = await apiLogin(email, password);
  const crewId = await teamId(adminSession, TEAM_CREW);
  const nightId = await teamId(adminSession, TEAM_NIGHT);
  const credentials: Array<{ team: string; teamName: string; email: string; password: string }> =
    [];
  for (const [id, name] of [
    [crewId, TEAM_CREW],
    [nightId, TEAM_NIGHT],
  ] as const) {
    await removeTemporaryManagers(adminSession, id);
    credentials.push({
      team: id,
      teamName: name,
      ...(await createTemporaryManager(adminSession, id, name)),
    });
  }

  const pages: Array<{ page: string; team: string; path: string }> = [
    { page: "overview", team: TEAM_CREW, path: "/" },
    { page: "overview", team: TEAM_NIGHT, path: "/" },
    { page: "requests-history", team: TEAM_CREW, path: "/requests?view=history" },
    { page: "member-m1", team: TEAM_CREW, path: `/members/${m1}` },
    { page: "audit", team: TEAM_CREW, path: `/audit?to=${encodeURIComponent(AUDIT_TO)}` },
    { page: "audit", team: TEAM_NIGHT, path: `/audit?to=${encodeURIComponent(AUDIT_TO)}` },
    { page: "usage", team: TEAM_CREW, path: "/usage?period=7d" },
  ];
  const viewports = [
    { width: 1280, height: 900 },
    { width: 360, height: 800 },
  ] as const;
  const themes = ["light", "dark"] as const;

  const browser = await chromium.launch();
  const shots: PageShot[] = [];
  try {
    for (const credential of credentials) {
      const context = await browser.newContext({ baseURL: CONTROL_URL });
      const page = await context.newPage();
      await page.goto("/login");
      await page.fill("#login-email", credential.email);
      await page.fill("#login-password", credential.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login")),
        page.click('button[type="submit"]'),
      ]);
      log(`signed in as the ${credential.teamName} console manager`);
      for (const definition of pages.filter((entry) => entry.team === credential.teamName)) {
        for (const viewport of viewports) {
          for (const theme of themes) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.emulateMedia({ colorScheme: theme });
            const response = await page.goto(definition.path, { waitUntil: "networkidle" });
            const title = await page.title();
            const file = `${definition.page}-${definition.team.toLowerCase()}-${viewport.width}-${theme}.png`;
            await page.screenshot({ path: join(OUT_DIR, file), fullPage: true });
            shots.push({
              file,
              page: definition.page,
              team: definition.team,
              width: viewport.width,
              theme,
              url: definition.path,
              title,
              capturedAt: new Date().toISOString(),
            });
            log(`${file} HTTP ${response?.status() ?? "?"} "${title}"`);
          }
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        note: "One temporary manager per team was created for the console login because the Leader passwords were not recoverable; see results/dogfood.json.",
        auditTo: AUDIT_TO,
        screenshots: shots,
      },
      null,
      2,
    )}\n`,
  );
  log(`wrote ${shots.length} screenshots and ${MANIFEST}`);
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
