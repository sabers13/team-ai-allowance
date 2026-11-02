import assert from "node:assert/strict";
import { test } from "node:test";
import type { Viewer } from "../../src/console/data.ts";
import {
  type Console,
  type ConsoleRequest,
  type ConsoleResponse,
  createConsole,
  createFixtureConsole,
} from "../../src/console/index.ts";

interface Harness {
  app: Console;
  viewer: Viewer;
  csrf: string;
  get(
    url: string,
    options?: { cookies?: Record<string, string>; session?: Viewer | null },
  ): Promise<ConsoleResponse>;
  post(
    url: string,
    form: Record<string, string> | URLSearchParams,
    options?: { enhanced?: boolean; cookies?: Record<string, string>; session?: Viewer | null },
  ): Promise<ConsoleResponse>;
}

function harness(): Harness {
  const fixture = createFixtureConsole();
  const app = createConsole({
    data: fixture.data,
    actions: fixture.actions,
    auth: fixture.auth,
    now: () => fixture.now,
    timeZone: fixture.timeZone,
    allowSimulation: true,
  });
  const viewer = fixture.viewer;
  const csrf = viewer.csrfToken;

  async function send(request: ConsoleRequest): Promise<ConsoleResponse> {
    return app.handle(request);
  }

  return {
    app,
    viewer,
    csrf,
    get(url, options) {
      const session = options?.session === undefined ? viewer : options.session;
      return send({
        method: "GET",
        url,
        headers: {},
        form: null,
        cookies: options?.cookies ?? {},
        session,
      });
    },
    post(url, form, options) {
      const session = options?.session === undefined ? viewer : options.session;
      const body = form instanceof URLSearchParams ? form : new URLSearchParams(form);
      const headers: Record<string, string | undefined> = {};
      if (options?.enhanced === true) headers["x-taa-enhance"] = "1";
      return send({
        method: "POST",
        url,
        headers,
        form: body,
        cookies: options?.cookies ?? {},
        session,
      });
    },
  };
}

function page(result: ConsoleResponse): string {
  return result.body;
}

test("every manager page renders with a heading and the shared shell", async () => {
  const h = harness();
  const pages: Array<[string, string]> = [
    ["/", "Overview"],
    ["/requests", "Requests"],
    ["/requests/req_0001", "Requests"],
    ["/members/mem_lena", "Lena"],
    ["/models", "Models"],
    ["/rules", "Rules"],
    ["/audit", "Audit"],
    ["/setup", "Setup"],
    ["/me", "My allowance"],
    ["/usage", "Usage"],
  ];
  for (const [url, heading] of pages) {
    const result = await h.get(url);
    assert.equal(result.status, 200, url);
    assert.equal(result.headers["content-type"], "text/html; charset=utf-8", url);
    assert.match(page(result), new RegExp(`<h1[^>]*>${heading}</h1>`), url);
    assert.match(page(result), /<html lang="en" data-theme="/, url);
    assert.match(page(result), /Skip to content/, url);
  }
});

test("the stylesheet and the enhancement script are served locally", async () => {
  const h = harness();
  const css = await h.get("/console.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"] ?? "", /text\/css/);
  assert.match(page(css), /--accent: #2f5fd0/);

  const js = await h.get("/console.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"] ?? "", /javascript/);
  assert.match(page(js), /data-enhance/);
});

test("an unauthenticated request goes to the sign-in page and keeps the target", async () => {
  const h = harness();
  const result = await h.get("/models", { session: null });
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, "/login?next=%2Fmodels");
});

test("the sign-in page renders, a good login sets a cookie and a bad one does not", async () => {
  const h = harness();
  const login = await h.get("/login", { session: null });
  assert.equal(login.status, 200);
  assert.match(page(login), /<h1[^>]*>Sign in<\/h1>/);

  const ok = await h.post("/login", {
    email: "priya@example.com",
    password: "anything",
    next: "/models",
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, "/models");
  assert.match(ok.headers["set-cookie"] ?? "", /taa_session=/);
  assert.match(ok.headers["set-cookie"] ?? "", /HttpOnly/);

  const bad = await h.post("/login", { email: "priya@example.com", password: "", next: "/" });
  assert.equal(bad.status, 401);
  assert.match(page(bad), /Enter your password/);

  const stranger = await h.post("/login", {
    email: "nobody@example.com",
    password: "x",
    next: "/",
  });
  assert.equal(stranger.status, 401);
});

test("a member is sent to My allowance instead of a manager page", async () => {
  const h = harness();
  const memberViewer: Viewer = {
    ...h.viewer,
    role: "member",
    displayName: "Lena",
    memberId: "mem_lena",
  };
  const result = await h.get("/models", { session: memberViewer });
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, "/me");
  const me = await h.get("/me", { session: memberViewer });
  assert.equal(me.status, 200);
  assert.match(page(me), /Remaining/);
});

test("the theme cookie is read on the server and a POST writes it", async () => {
  const h = harness();
  const dark = await h.get("/", { cookies: { taa_theme: "dark" } });
  assert.match(page(dark), /<html lang="en" data-theme="dark">/);
  const light = await h.get("/", { cookies: { taa_theme: "light" } });
  assert.match(page(light), /data-theme="light"/);

  const set = await h.post("/theme", { _csrf: h.csrf, theme: "dark", returnTo: "/models" });
  assert.equal(set.status, 303);
  assert.equal(set.headers.location, "/models?notice=theme-saved");
  assert.match(set.headers["set-cookie"] ?? "", /taa_theme=dark/);
  assert.match(set.headers["set-cookie"] ?? "", /SameSite=Strict/);

  const system = await h.post("/theme", { _csrf: h.csrf, theme: "system", returnTo: "/" });
  assert.match(system.headers["set-cookie"] ?? "", /Max-Age=0/);
});

test("a form without the right CSRF token is refused", async () => {
  const h = harness();
  const result = await h.post("/requests/req_0001/decide", {
    _csrf: "wrong",
    outcome: "approved",
    returnTo: "/requests/req_0001",
  });
  assert.equal(result.status, 403);
  assert.match(page(result), /token did not match/);
  const detail = await h.get("/requests/req_0001");
  assert.match(page(detail), /Pending/);
});

test("approving without JavaScript is a redirect and the page shows the decision", async () => {
  const h = harness();
  const result = await h.post("/requests/req_0001/decide", {
    _csrf: h.csrf,
    outcome: "approved",
    note: "One week only.",
    returnTo: "/requests/req_0001",
  });
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, "/requests/req_0001?notice=request-approved");
  const detail = await h.get(result.headers.location ?? "/requests/req_0001");
  const body = page(detail);
  assert.match(body, /Request approved/);
  assert.match(body, /One week only\./);
  assert.match(body, /Decision/);
});

test("denying reaches the decision and keeps the note", async () => {
  const h = harness();
  const result = await h.post("/requests/req_0002/decide", {
    _csrf: h.csrf,
    outcome: "denied",
    note: "Use the enabled model and report back.",
    returnTo: "/requests/req_0002",
  });
  assert.equal(result.status, 303);
  const detail = await h.get("/requests/req_0002");
  assert.match(page(detail), /Denied/);
  assert.match(page(detail), /Use the enabled model/);
});

test("the enhanced decide answers JSON and names the card to remove", async () => {
  const h = harness();
  const result = await h.post(
    "/requests/req_0001/decide",
    { _csrf: h.csrf, outcome: "approved", returnTo: "/requests" },
    { enhanced: true },
  );
  assert.equal(result.status, 200);
  assert.match(result.headers["content-type"] ?? "", /application\/json/);
  const payload = JSON.parse(page(result)) as {
    ok: boolean;
    message: string;
    removeSelector: string;
    openRequests: number;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.removeSelector, "#request-req_0001");
  assert.equal(payload.openRequests, 3);
  assert.match(payload.message, /approved/i);
});

test("an enhanced failure is JSON with the readable message", async () => {
  const h = harness();
  const result = await h.post(
    "/requests/req_0001/decide",
    { _csrf: h.csrf, outcome: "partly_approved", amountUsd: "99", returnTo: "/requests" },
    { enhanced: true },
  );
  assert.equal(result.status, 422);
  const payload = JSON.parse(page(result)) as { ok: boolean; message: string };
  assert.equal(payload.ok, false);
  assert.match(payload.message, /requested amount is 10\.00/);
});

test("a failed no-JS action re-renders the page with the error and a 422", async () => {
  const h = harness();
  const result = await h.post("/requests/req_0001/decide", {
    _csrf: h.csrf,
    outcome: "partly_approved",
    amountUsd: "99",
    returnTo: "/requests/req_0001",
  });
  assert.equal(result.status, 422);
  assert.match(page(result), /requested amount is 10\.00/);
});

test("limits, models, rules and policy forms save through the handler", async () => {
  const h = harness();

  const limits = await h.post("/members/mem_lena/limits", {
    _csrf: h.csrf,
    returnTo: "/members/mem_lena",
    budgetUsd: "24.50",
    period: "monthly",
    tokenCap: "120000",
    rpm: "30",
    tpm: "90000",
  });
  assert.equal(limits.status, 303);
  const member = await h.get("/members/mem_lena");
  assert.match(page(member), /24\.50/);
  assert.match(page(member), /120,000/);

  const models = await h.post("/members/mem_lena/models", {
    _csrf: h.csrf,
    returnTo: "/members/mem_lena",
    modelId: "deepseek-v4.1-flash",
  });
  assert.equal(models.status, 303);

  const rule = await h.post("/rules", {
    _csrf: h.csrf,
    returnTo: "/rules",
    kind: "budget_topup",
    name: "Tiny top-up",
    maxUsd: "1.50",
    oncePerDays: "3",
    enabled: "1",
  });
  assert.equal(rule.status, 303);
  const rules = await h.get("/rules");
  assert.match(page(rules), /Tiny top-up/);

  const policy = await h.post("/rules/policy", {
    _csrf: h.csrf,
    returnTo: "/rules",
    offHoursEnabled: "1",
    timeZone: "Europe/Berlin",
    start: "08:30",
    end: "18:30",
    workingDays: "1",
    offHoursCapUsd: "4.50",
    softRatio: "75",
    graceRatio: "10",
    unusualSpendMinUsd: "3.00",
    channel: "log",
  });
  assert.equal(policy.status, 303);
  const after = await h.get("/rules");
  assert.match(page(after), /75%|08:30/);
});

test("blocking and unblocking a key reaches the member page", async () => {
  const h = harness();
  const blocked = await h.post("/members/mem_omar/key/block", {
    _csrf: h.csrf,
    returnTo: "/members/mem_omar",
    reason: "Unusual spend",
  });
  assert.equal(blocked.status, 303);
  assert.match(page(await h.get("/members/mem_omar")), /Unusual spend/);

  const unblocked = await h.post("/members/mem_omar/key/unblock", {
    _csrf: h.csrf,
    returnTo: "/members/mem_omar",
  });
  assert.equal(unblocked.status, 303);
});

test("rotating a key shows the secret once on the member page", async () => {
  const h = harness();
  const result = await h.post("/members/mem_lena/key/rotate", {
    _csrf: h.csrf,
    returnTo: "/members/mem_lena",
  });
  assert.equal(result.status, 200);
  const secret = /taa_key_fixture_\d+/.exec(page(result))?.[0];
  assert.ok(secret);
  assert.match(page(result), /shown once/);
  const again = await h.get("/members/mem_lena");
  assert.equal(page(again).includes(secret), false);
});

test("enrolment shows the key once and the bundle is a download", async () => {
  const h = harness();
  const result = await h.post("/setup/members", {
    _csrf: h.csrf,
    returnTo: "/setup",
    displayName: "Nora",
    email: "nora@example.com",
    role: "member",
    budgetUsd: "25.00",
    period: "weekly",
  });
  assert.equal(result.status, 200);
  const secret = /taa_key_fixture_\d+/.exec(page(result))?.[0];
  assert.ok(secret);
  assert.match(page(result), /Nora is enrolled/);
  assert.match(page(result), /Download the config bundle/);

  const setup = await h.get("/setup");
  assert.equal(page(setup).includes(secret), false);

  const bundle = await h.get("/setup/bundle/mem_lena");
  assert.equal(bundle.status, 200);
  assert.match(
    bundle.headers["content-disposition"] ?? "",
    /attachment; filename="taa-mem_lena\.env"/,
  );
  assert.match(page(bundle), /TAA_MEMBER_KEY=__paste_the_key_shown_at_enrolment__/);
});

test("the whole request path works from My allowance", async () => {
  const h = harness();
  const sent = await h.post("/me/requests", {
    _csrf: h.csrf,
    returnTo: "/me",
    kind: "more_budget",
    amountUsd: "5.00",
    message: "One more test run before the release.",
  });
  assert.equal(sent.status, 303);
  const me = await h.get("/me");
  assert.match(page(me), /One more test run before the release/);
});

test("the empty, loading and error states are rendered on every list surface", async () => {
  const h = harness();

  const empty = await h.get("/?simulate=empty");
  assert.match(page(empty), /No members yet/);
  assert.match(page(empty), /No open requests/);
  assert.match(page(empty), /No spend recorded yet/);

  const loading = await h.get("/requests?simulate=loading");
  assert.match(page(loading), /Loading requests…/);

  const error = await h.get("/audit?simulate=error");
  assert.match(page(error), /This list could not be loaded/);
  assert.match(page(error), /Try again/);
});

test("the open-request counter endpoint answers JSON", async () => {
  const h = harness();
  const result = await h.get("/requests/count");
  assert.equal(result.status, 200);
  assert.match(result.headers["content-type"] ?? "", /application\/json/);
  const payload = JSON.parse(page(result)) as { open: number };
  assert.equal(payload.open, 4);
});

test("the usage page and CSV answer for a manager and a member is sent to /me", async () => {
  const h = harness();
  const usage = await h.get("/usage?period=7&series=model");
  assert.equal(usage.status, 200);
  assert.match(page(usage), /Daily cost/);
  assert.match(page(usage), /By member/);
  assert.match(page(usage), /CLI \(inferred\)/);
  assert.match(page(usage), /stacked by model/);

  const custom = await h.get("/usage?from=2026-10-29&to=2026-10-30");
  assert.equal(custom.status, 200);
  assert.match(page(custom), /2026-10-29 to 2026-10-30/);

  const csv = await h.get("/usage.csv?period=30&sort=requests&dir=asc");
  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"] ?? "", /text\/csv/);
  assert.match(
    csv.headers["content-disposition"] ?? "",
    /usage-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv/,
  );
  assert.match(page(csv), /^member,member_id,status,requests/);
  assert.match(page(csv), /cli_inferred/);

  const memberViewer: Viewer = { ...h.viewer, role: "member", memberId: "mem_lena" };
  const redirected = await h.get("/usage", { session: memberViewer });
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.location, "/me");
});

test("the usage page renders empty, loading and error states", async () => {
  const h = harness();
  const empty = await h.get("/usage?simulate=empty");
  assert.match(page(empty), /No usage in this period/);
  const loading = await h.get("/usage?simulate=loading");
  assert.match(page(loading), /Loading usage…/);
  const error = await h.get("/usage?simulate=error");
  assert.match(page(error), /This list could not be loaded/);
});

test("an unknown page and an unknown request render 404 pages", async () => {
  const h = harness();
  const missing = await h.get("/nope");
  assert.equal(missing.status, 404);
  assert.match(page(missing), /Page not found/);
  const request = await h.get("/requests/req_missing");
  assert.equal(request.status, 404);
  assert.match(page(request), /Request not found/);
});

test("a manager form posts with a member session are refused", async () => {
  const h = harness();
  const memberViewer: Viewer = { ...h.viewer, role: "member", memberId: "mem_lena" };
  const result = await h.post(
    "/members/mem_lena/limits",
    { _csrf: h.csrf, returnTo: "/me", budgetUsd: "999", period: "monthly" },
    { session: memberViewer },
  );
  assert.equal(result.status, 403);
  assert.match(page(result), /member cannot use a manager form/);
});

test("no page contains a key, a password or prompt text", async () => {
  const h = harness();
  for (const url of ["/", "/requests", "/members/mem_lena", "/setup", "/me", "/audit"]) {
    const body = page(await h.get(url));
    assert.equal(body.includes("taa_key_fixture"), false, url);
    assert.equal(body.toLowerCase().includes("password:"), false, url);
    assert.equal(body.includes("You are a helpful assistant"), false, url);
  }
});
