import type {
  DeliveryResult,
  Notification,
  NotificationChannel,
  Notifier,
  TeamPolicy,
} from "../contracts.ts";
import { loadNotifyConfig, type NotifyConfig } from "./config.ts";
import { postJson } from "./http.ts";
import { emailPayload, slackPayload, teamsPayload, webhookPayload } from "./payloads.ts";
import { sendSmtpMail } from "./smtp.ts";

/**
 * Notification fan-out across configured channels.
 *
 * - The log channel always runs and always succeeds.
 * - Every configured channel gets one attempt, then one retry.
 * - A channel failure is recorded with a status code and an error class, never
 *   a webhook URL or a response body, and never blocks the caller.
 * - A successful `(channel, dedupeKey)` pair is not sent twice.
 */

export type NotifyLogger = (line: string) => void;

export const silentNotifyLogger: NotifyLogger = () => {};

export interface NotifySender {
  channel: NotificationChannel;
  send(notification: Notification): Promise<{
    ok: boolean;
    status: number | null;
    error: string | null;
  }>;
}

export interface FanoutOptions {
  config?: NotifyConfig;
  /** A team's policy; when it lists channels, they replace the env defaults. */
  policy?: TeamPolicy | null;
  env?: NodeJS.ProcessEnv;
  logger?: NotifyLogger;
}

function policyValue(policy: TeamPolicy | null, channel: NotificationChannel, key: string): string {
  if (policy === null) return "";
  const entry = policy.notifications.find((item) => item.channel === channel && item.enabled);
  return entry?.config[key]?.trim() ?? "";
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  if (name.length === 0) return null;
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function policyEnvUrl(
  policy: TeamPolicy | null,
  channel: NotificationChannel,
  env: NodeJS.ProcessEnv,
): string | null {
  return envValue(env, policyValue(policy, channel, "urlEnv"));
}

function hasPolicyChannels(policy: TeamPolicy | null): boolean {
  return policy?.notifications.some((entry) => entry.enabled) ?? false;
}

function httpSender(channel: NotificationChannel, url: string, config: NotifyConfig): NotifySender {
  return {
    channel,
    send: (notification) => {
      const payload =
        channel === "teams"
          ? teamsPayload(notification)
          : channel === "slack"
            ? slackPayload(notification)
            : webhookPayload(notification);
      return postJson(url, payload, { timeoutMs: config.timeoutMs });
    },
  };
}

function emailSender(
  url: string,
  config: NotifyConfig,
  policy: TeamPolicy | null,
): NotifySender | null {
  const toRaw = policyValue(policy, "email", "to") || config.mailTo || "";
  const to = toRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (to.length === 0) return null;
  const from = policyValue(policy, "email", "from") || config.mailFrom;
  return {
    channel: "email",
    send: async (notification) => {
      try {
        await sendSmtpMail({
          url,
          message: emailPayload(notification, from, to),
          timeoutMs: config.timeoutMs,
        });
        return { ok: true, status: null, error: null };
      } catch (error) {
        return {
          ok: false,
          status: null,
          error: error instanceof Error ? error.name : "Error",
        };
      }
    },
  };
}

function safeUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function safeSmtpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "smtp:" || parsed.protocol === "smtps:" ? value : null;
  } catch {
    return null;
  }
}

/** Build the enabled channels: team policy first, then the environment. */
export function channelsFor(options: FanoutOptions = {}): NotifySender[] {
  const config = options.config ?? loadNotifyConfig();
  const policy = options.policy ?? null;
  const env = options.env ?? process.env;
  const fromPolicy = hasPolicyChannels(policy);
  const channels: NotifySender[] = [];

  const teamsUrl = fromPolicy
    ? safeUrl(policyEnvUrl(policy, "teams", env))
    : safeUrl(config.teamsUrl);
  if (teamsUrl !== null) channels.push(httpSender("teams", teamsUrl, config));

  const slackUrl = fromPolicy
    ? safeUrl(policyEnvUrl(policy, "slack", env))
    : safeUrl(config.slackUrl);
  if (slackUrl !== null) channels.push(httpSender("slack", slackUrl, config));

  const webhookUrl = fromPolicy
    ? safeUrl(policyEnvUrl(policy, "webhook", env))
    : safeUrl(config.webhookUrl);
  if (webhookUrl !== null) channels.push(httpSender("webhook", webhookUrl, config));

  const smtpUrl = fromPolicy
    ? safeSmtpUrl(policyEnvUrl(policy, "email", env) ?? config.smtpUrl)
    : safeSmtpUrl(config.smtpUrl);
  if (smtpUrl !== null) {
    const sender = emailSender(smtpUrl, config, policy);
    if (sender !== null) channels.push(sender);
  }

  return channels;
}

export class FanoutNotifier implements Notifier {
  private readonly senders: NotifySender[];
  private readonly logger: NotifyLogger;
  private readonly delivered = new Set<string>();

  constructor(options: FanoutOptions & { senders?: NotifySender[] } = {}) {
    this.senders = options.senders ?? channelsFor(options);
    this.logger = options.logger ?? console.log;
  }

  /** Send once to the log and to every channel, retrying each failure once. */
  async send(notification: Notification): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    const logLine = `notify ${notification.kind} audience=${notification.audience} team=${notification.teamId} member=${notification.memberId ?? "-"} dedupe=${notification.dedupeKey}`;
    try {
      this.logger(logLine);
    } catch {
      // A broken logger must not block delivery.
    }
    results.push({ channel: "log", ok: true, status: null, error: null });

    for (const sender of this.senders) {
      const key = `${sender.channel}:${notification.dedupeKey}`;
      if (this.delivered.has(key)) {
        results.push({ channel: sender.channel, ok: true, status: null, error: null });
        continue;
      }
      const first = await this.attempt(sender, notification);
      const final = first.ok ? first : await this.attempt(sender, notification);
      if (final.ok) this.delivered.add(key);
      else
        this.logger?.(`notify-failed channel=${sender.channel} error=${final.error ?? "unknown"}`);
      results.push({
        channel: sender.channel,
        ok: final.ok,
        status: final.status,
        error: final.error,
      });
    }
    return results;
  }

  private async attempt(
    sender: NotifySender,
    notification: Notification,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    try {
      return await sender.send(notification);
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.name : "Error",
      };
    }
  }
}

/** A notifier for one team policy plus the environment defaults. */
export function createNotifier(options: FanoutOptions = {}): Notifier {
  return new FanoutNotifier(options);
}
