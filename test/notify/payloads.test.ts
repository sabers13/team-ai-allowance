import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notification } from "../../src/contracts.ts";
import {
  emailPayload,
  slackPayload,
  teamsPayload,
  webhookPayload,
} from "../../src/notify/payloads.ts";

function notice(): Notification {
  return {
    id: "ntf_1",
    at: "2026-10-05T08:00:00.000Z",
    kind: "request_created",
    audience: "manager",
    teamId: "team_1",
    memberId: "mem_1",
    title: "Budget request from Lena",
    body: "Lena asked for USD 10.00 for a migration.",
    link: "https://console.example.com/requests",
    dedupeKey: "request:req_1:manager",
  };
}

test("the Teams payload is a message with one Adaptive Card attachment", () => {
  const payload = teamsPayload(notice());
  assert.equal(payload.type, "message");
  assert.equal(payload.attachments.length, 1);
  const attachment = payload.attachments[0];
  assert.ok(attachment !== undefined);
  assert.equal(attachment.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(attachment.content.type, "AdaptiveCard");
  assert.equal(attachment.content.version, "1.2");
  const json = JSON.stringify(payload);
  assert.match(json, /Budget request from Lena/u);
  assert.match(json, /Action\.OpenURL/u);
  assert.match(json, /https:\/\/console\.example\.com\/requests/u);
});

test("a Teams card without a link has no action", () => {
  const payload = teamsPayload({ ...notice(), link: null });
  assert.deepEqual(payload.attachments[0]?.content.actions, []);
});

test("the Slack payload is the simple text form with the link", () => {
  const payload = slackPayload(notice());
  assert.match(payload.text, /^Budget request from Lena: Lena asked for USD 10\.00/u);
  assert.match(payload.text, /https:\/\/console\.example\.com\/requests$/u);
});

test("the generic webhook carries the stable dedupe key", () => {
  assert.deepEqual(webhookPayload(notice()), {
    id: "ntf_1",
    at: "2026-10-05T08:00:00.000Z",
    kind: "request_created",
    audience: "manager",
    teamId: "team_1",
    memberId: "mem_1",
    title: "Budget request from Lena",
    body: "Lena asked for USD 10.00 for a migration.",
    link: "https://console.example.com/requests",
    dedupeKey: "request:req_1:manager",
  });
});

test("the e-mail is plain text with a subject, recipients and the link", () => {
  const message = emailPayload(notice(), "taa@example.com", ["priya@example.com"]);
  assert.equal(message.subject, "[team-ai-allowance] Budget request from Lena");
  assert.deepEqual(message.to, ["priya@example.com"]);
  assert.match(message.body, /Lena asked for USD 10\.00/u);
  assert.match(message.body, /https:\/\/console\.example\.com\/requests/u);
  assert.doesNotMatch(message.body, /<html/iu);
});
