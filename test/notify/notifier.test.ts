import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Notification, TeamPolicy } from "../../src/contracts.ts";
import {
  createNotifier,
  loadNotifyConfig,
  type NotifyConfig,
  silentNotifyLogger,
} from "../../src/notify/index.ts";

interface Captured {
  path: string;
  body: string;
}

async function startCatcher(
  answer: (index: number, captured: Captured) => number = () => 200,
): Promise<{ url: string; requests: Captured[]; close(): Promise<void> }> {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const captured = {
        path: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const status = answer(requests.length - 1, captured);
      response.statusCode = status;
      response.end(status >= 200 && status < 300 ? "ok" : "no");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function notice(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "ntf_1",
    at: "2026-10-05T08:00:00.000Z",
    kind: "soft_limit",
    audience: "member",
    teamId: "team_1",
    memberId: "mem_1",
    title: "Soft limit reached",
    body: "Lena passed 80% of the daily budget.",
    link: "https://console.example.com/me",
    dedupeKey: "threshold:mem_1:soft_limit:2026-10-05T00:00:00.000Z:member",
    ...overrides,
  };
}

function config(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    teamsUrl: null,
    slackUrl: null,
    webhookUrl: null,
    smtpUrl: null,
    mailFrom: "taa@example.com",
    mailTo: null,
    timeoutMs: 1000,
    ...overrides,
  };
}

test("Teams, Slack and the webhook each receive their own shape", async () => {
  const catcher = await startCatcher();
  try {
    const notifier = createNotifier({
      config: config({
        teamsUrl: `${catcher.url}/teams`,
        slackUrl: `${catcher.url}/slack`,
        webhookUrl: `${catcher.url}/hook`,
      }),
      env: {},
      logger: silentNotifyLogger,
    });
    const results = await notifier.send(notice());
    assert.deepEqual(results.map((result) => result.channel).sort(), [
      "log",
      "slack",
      "teams",
      "webhook",
    ]);
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    assert.equal(catcher.requests.length, 3);

    const teams = catcher.requests.find((request) => request.path === "/teams");
    assert.ok(teams !== undefined);
    assert.equal(JSON.parse(teams.body).attachments[0].content.type, "AdaptiveCard");

    const slack = catcher.requests.find((request) => request.path === "/slack");
    assert.ok(slack !== undefined);
    assert.match(JSON.parse(slack.body).text, /Soft limit reached/u);

    const hook = catcher.requests.find((request) => request.path === "/hook");
    assert.ok(hook !== undefined);
    assert.equal(JSON.parse(hook.body).dedupeKey, notice().dedupeKey);
  } finally {
    await catcher.close();
  }
});

test("a failing channel is retried once and then recorded as failed", async () => {
  const catcher = await startCatcher((index) => (index === 0 ? 500 : 200));
  try {
    const notifier = createNotifier({
      config: config({ webhookUrl: `${catcher.url}/hook` }),
      env: {},
      logger: silentNotifyLogger,
    });
    const results = await notifier.send(notice());
    assert.equal(catcher.requests.length, 2);
    const webhook = results.find((result) => result.channel === "webhook");
    assert.equal(webhook?.ok, true);
    assert.equal(webhook?.status, 200);
  } finally {
    await catcher.close();
  }
});

test("a channel that keeps failing does not stop the others and never throws", async () => {
  const catcher = await startCatcher(() => 503);
  try {
    const notifier = createNotifier({
      config: config({
        teamsUrl: `${catcher.url}/teams`,
        webhookUrl: `${catcher.url}/hook`,
      }),
      env: {},
      logger: silentNotifyLogger,
    });
    const results = await notifier.send(notice());
    assert.equal(catcher.requests.length, 4, "two attempts per channel");
    const byChannel = new Map(results.map((result) => [result.channel, result]));
    assert.equal(byChannel.get("log")?.ok, true);
    assert.equal(byChannel.get("teams")?.ok, false);
    assert.equal(byChannel.get("webhook")?.ok, false);
    assert.equal(byChannel.get("webhook")?.status, 503);
    assert.equal(byChannel.get("webhook")?.error, "non_2xx");
    assert.doesNotMatch(JSON.stringify(results), /127\.0\.0\.1/u, "no URL is reported");
  } finally {
    await catcher.close();
  }
});

test("an unreachable host is a failed delivery, not an exception", async () => {
  const catcher = await startCatcher();
  const url = catcher.url;
  await catcher.close();
  const notifier = createNotifier({
    config: config({ webhookUrl: `${url}/gone` }),
    env: {},
    logger: silentNotifyLogger,
  });
  const results = await notifier.send(notice());
  const webhook = results.find((result) => result.channel === "webhook");
  assert.equal(webhook?.ok, false);
  assert.equal(webhook?.status, null);
});

test("the same dedupe key is delivered to a channel only once", async () => {
  const catcher = await startCatcher();
  try {
    const notifier = createNotifier({
      config: config({ webhookUrl: `${catcher.url}/hook` }),
      env: {},
      logger: silentNotifyLogger,
    });
    await notifier.send(notice());
    await notifier.send(notice());
    assert.equal(catcher.requests.length, 1);
  } finally {
    await catcher.close();
  }
});

test("the log channel always runs, even with no channel configured", async () => {
  const lines: string[] = [];
  const notifier = createNotifier({
    config: config(),
    env: {},
    logger: (line) => lines.push(line),
  });
  const results = await notifier.send(notice());
  assert.deepEqual(results, [{ channel: "log", ok: true, status: null, error: null }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /notify soft_limit/u);
});

test("a team policy names webhook URLs by environment variable", async () => {
  const catcher = await startCatcher();
  try {
    const policy: TeamPolicy = {
      teamId: "team_1",
      offHours: {
        enabled: true,
        timeZone: "Europe/Berlin",
        workingDays: [1, 2, 3, 4, 5],
        startMinute: 420,
        endMinute: 1140,
        holidays: [],
        capUsd: 5,
      },
      thresholds: { softRatio: 0.8, graceRatio: 0.05 },
      unusualSpendMinUsd: 2,
      notifications: [
        { channel: "webhook", config: { urlEnv: "TAA_TEST_HOOK" }, enabled: true },
        { channel: "slack", config: { urlEnv: "TAA_TEST_SLACK" }, enabled: false },
      ],
      updatedAt: "2026-10-05T08:00:00.000Z",
    };
    const notifier = createNotifier({
      config: config({ slackUrl: `${catcher.url}/ignored` }),
      policy,
      env: { TAA_TEST_HOOK: `${catcher.url}/hook`, TAA_TEST_SLACK: `${catcher.url}/slack` },
      logger: silentNotifyLogger,
    });
    const results = await notifier.send(notice());
    assert.deepEqual(results.map((result) => result.channel).sort(), ["log", "webhook"]);
    assert.equal(catcher.requests.length, 1);
    assert.equal(catcher.requests[0]?.path, "/hook");
  } finally {
    await catcher.close();
  }
});

test("loadNotifyConfig reads the documented variables and never leaks a URL in its shape", () => {
  const loaded = loadNotifyConfig({
    TAA_TEAMS_WEBHOOK: "https://teams.example.com/hook",
    TAA_SLACK_WEBHOOK: "https://hooks.slack.com/services/x",
    TAA_GENERIC_WEBHOOK: "https://example.com/hook",
    TAA_SMTP_URL: "smtp://127.0.0.1:1025",
    TAA_MAIL_FROM: "taa@example.com",
    TAA_MAIL_TO: "priya@example.com",
    TAA_NOTIFY_TIMEOUT_MS: "2500",
  });
  assert.equal(loaded.teamsUrl, "https://teams.example.com/hook");
  assert.equal(loaded.smtpUrl, "smtp://127.0.0.1:1025");
  assert.equal(loaded.mailTo, "priya@example.com");
  assert.equal(loaded.timeoutMs, 2500);
});

test("loadNotifyConfig has safe defaults and rejects an implausible timeout", () => {
  assert.deepEqual(loadNotifyConfig({}), {
    teamsUrl: null,
    slackUrl: null,
    webhookUrl: null,
    smtpUrl: null,
    mailFrom: "team-ai-allowance@localhost",
    mailTo: null,
    timeoutMs: 5000,
  });
  assert.equal(loadNotifyConfig({ TAA_NOTIFY_TIMEOUT_MS: "1" }).timeoutMs, 5000);
  assert.equal(loadNotifyConfig({ TAA_NOTIFY_TIMEOUT_MS: "later" }).timeoutMs, 5000);
});
