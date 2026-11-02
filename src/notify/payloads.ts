import type { Notification } from "../contracts.ts";

/**
 * Channel payload builders for Teams, Slack, SMTP and generic webhooks.
 *
 * Every builder copies only control-plane fields: kind, ids, title, body and
 * link. The notification itself never contains prompt or response text.
 */

export interface TeamsCardPayload {
  type: "message";
  attachments: Array<{
    contentType: "application/vnd.microsoft.card.adaptive";
    contentUrl: null;
    content: {
      $schema: string;
      type: "AdaptiveCard";
      version: "1.2";
      body: unknown[];
      actions: unknown[];
    };
  }>;
}

const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

export function teamsPayload(notification: Notification): TeamsCardPayload {
  const facts: Array<{ title: string; value: string }> = [
    { title: "Kind", value: notification.kind },
    { title: "Audience", value: notification.audience },
    { title: "When", value: notification.at },
  ];
  if (notification.memberId !== null) {
    facts.push({ title: "Member", value: notification.memberId });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: CARD_SCHEMA,
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            {
              type: "TextBlock",
              text: notification.title,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
            },
            { type: "FactSet", facts },
            { type: "TextBlock", text: notification.body, wrap: true },
          ],
          actions:
            notification.link === null
              ? []
              : [{ type: "Action.OpenURL", title: "Open the console", url: notification.link }],
        },
      },
    ],
  };
}

export interface SlackPayload {
  text: string;
}

/** The simple text form plus the link, so previews read the same as a channel. */
export function slackPayload(notification: Notification): SlackPayload {
  const link = notification.link === null ? "" : ` ${notification.link}`;
  return { text: `${notification.title}: ${notification.body}${link}` };
}

/** The generic webhook body. Stable, small, no HTML. */
export function webhookPayload(notification: Notification): Record<string, unknown> {
  return {
    id: notification.id,
    at: notification.at,
    kind: notification.kind,
    audience: notification.audience,
    teamId: notification.teamId,
    memberId: notification.memberId,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    dedupeKey: notification.dedupeKey,
  };
}

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  body: string;
}

export function emailPayload(notification: Notification, from: string, to: string[]): EmailMessage {
  const link = notification.link === null ? "" : `\n\n${notification.link}`;
  return {
    from,
    to,
    subject: `[team-ai-allowance] ${notification.title}`,
    body: `${notification.title}\n\n${notification.body}\n\nKind: ${notification.kind}\nAt: ${notification.at}${link}\n`,
  };
}
