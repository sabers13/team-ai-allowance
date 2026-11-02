/**
 * Public entry point for the notification module.
 *
 * Other lanes import from here only. They get the `Notifier` implementation,
 * the payload builders used by tests and the config loader.
 */

export type { NotifyConfig } from "./config.ts";
export { loadNotifyConfig } from "./config.ts";
export { isHttpChannel, postJson } from "./http.ts";
export type {
  FanoutOptions,
  NotifyLogger,
  NotifySender,
} from "./notifier.ts";
export {
  channelsFor,
  createNotifier,
  FanoutNotifier,
  silentNotifyLogger,
} from "./notifier.ts";
export type { EmailMessage, SlackPayload, TeamsCardPayload } from "./payloads.ts";
export { emailPayload, slackPayload, teamsPayload, webhookPayload } from "./payloads.ts";
export type { SmtpSendOptions, SmtpTarget } from "./smtp.ts";
export { parseSmtpUrl, sendSmtpMail } from "./smtp.ts";
