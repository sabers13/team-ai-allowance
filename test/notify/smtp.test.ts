import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import type { Notification } from "../../src/contracts.ts";
import {
  createNotifier,
  parseSmtpUrl,
  sendSmtpMail,
  silentNotifyLogger,
} from "../../src/notify/index.ts";

interface SmtpCatcher {
  url: string;
  messages: string[];
  close(): Promise<void>;
}

async function startSmtpCatcher(): Promise<SmtpCatcher> {
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let data = "";
    socket.write("220 catcher ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(data);
          data = "";
          inData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-catcher\r\n250 HELP\r\n");
        else if (verb === "QUIT") {
          socket.write("221 2.0.0 bye\r\n");
          socket.end();
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 end with .\r\n");
        } else if (verb === "AUTH") socket.write("235 2.7.0 authenticated\r\n");
        else socket.write("250 2.0.0 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${address.port}`,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function notice(): Notification {
  return {
    id: "ntf_mail_1",
    at: "2026-10-05T08:00:00.000Z",
    kind: "soft_limit",
    audience: "member",
    teamId: "team_1",
    memberId: "mem_1",
    title: "Soft limit reached",
    body: "Lena passed 80% of the daily budget.",
    link: "https://console.example.com/me",
    dedupeKey: "threshold:mem_1:soft_limit:2026-10-05T00:00:00.000Z:member",
  };
}

test("the SMTP channel delivers one plain-text message to a local catcher", async () => {
  const catcher = await startSmtpCatcher();
  try {
    const notifier = createNotifier({
      config: {
        teamsUrl: null,
        slackUrl: null,
        webhookUrl: null,
        smtpUrl: catcher.url,
        mailFrom: "taa@example.com",
        mailTo: "priya@example.com, omar@example.com",
        timeoutMs: 2000,
      },
      env: {},
      logger: silentNotifyLogger,
    });
    const results = await notifier.send(notice());
    const email = results.find((result) => result.channel === "email");
    assert.equal(email?.ok, true);
    assert.equal(catcher.messages.length, 1);
    const message = catcher.messages[0] ?? "";
    assert.match(message, /^From: taa@example\.com\r$/mu);
    assert.match(message, /^To: priya@example\.com, omar@example\.com\r$/mu);
    assert.match(message, /^Subject: \[team-ai-allowance\] Soft limit reached\r$/mu);
    assert.match(message, /Lena passed 80% of the daily budget\./u);
    assert.match(message, /https:\/\/console\.example\.com\/me/u);
    assert.doesNotMatch(message, /Content-Type: text\/html/iu);
  } finally {
    await catcher.close();
  }
});

test("an SMTP failure is reported and does not throw", async () => {
  const catcher = await startSmtpCatcher();
  const url = catcher.url;
  await catcher.close();
  const notifier = createNotifier({
    config: {
      teamsUrl: null,
      slackUrl: null,
      webhookUrl: null,
      smtpUrl: url,
      mailFrom: "taa@example.com",
      mailTo: "priya@example.com",
      timeoutMs: 300,
    },
    env: {},
    logger: silentNotifyLogger,
  });
  const results = await notifier.send(notice());
  const email = results.find((result) => result.channel === "email");
  assert.equal(email?.ok, false);
});

test("the SMTP sender escapes a body line that starts with a dot", async () => {
  const catcher = await startSmtpCatcher();
  try {
    await sendSmtpMail({
      url: catcher.url,
      timeoutMs: 2000,
      message: {
        from: "taa@example.com",
        to: ["priya@example.com"],
        subject: "dot",
        body: ".hidden line",
      },
    });
    assert.equal(catcher.messages.length, 1);
    assert.match(catcher.messages[0] ?? "", /\r\n\.\.hidden line/u);
  } finally {
    await catcher.close();
  }
});

test("parseSmtpUrl reads protocol, port, credentials and STARTTLS", () => {
  const plain = parseSmtpUrl("smtp://127.0.0.1:1025");
  assert.deepEqual(plain, {
    host: "127.0.0.1",
    port: 1025,
    secure: false,
    starttls: false,
    username: null,
    password: null,
  });

  const auth = parseSmtpUrl("smtp://user:secret@mail.example.com:2525?starttls=1");
  assert.equal(auth.username, "user");
  assert.equal(auth.password, "secret");
  assert.equal(auth.starttls, true);
  assert.equal(auth.port, 2525);

  const secure = parseSmtpUrl("smtps://mail.example.com");
  assert.equal(secure.secure, true);
  assert.equal(secure.port, 465);

  assert.throws(() => parseSmtpUrl("https://example.com"), /smtp/u);
});
