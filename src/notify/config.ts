/**
 * The notify module's one config module.
 *
 * Channel secrets are URLs, so they are read from the environment or from a
 * team policy entry that names an environment variable. A URL is never written
 * to a log line, a delivery result or an audit event.
 */

export interface NotifyConfig {
  teamsUrl: string | null;
  slackUrl: string | null;
  webhookUrl: string | null;
  smtpUrl: string | null;
  mailFrom: string;
  mailTo: string | null;
  timeoutMs: number;
}

const DEFAULT_MAIL_FROM = "team-ai-allowance@localhost";
const DEFAULT_TIMEOUT_MS = 5000;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 60_000) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

/** Read the notification channel settings from the environment. */
export function loadNotifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    teamsUrl: clean(env.TAA_TEAMS_WEBHOOK),
    slackUrl: clean(env.TAA_SLACK_WEBHOOK),
    webhookUrl: clean(env.TAA_GENERIC_WEBHOOK),
    smtpUrl: clean(env.TAA_SMTP_URL),
    mailFrom: clean(env.TAA_MAIL_FROM) ?? DEFAULT_MAIL_FROM,
    mailTo: clean(env.TAA_MAIL_TO),
    timeoutMs: parseTimeout(env.TAA_NOTIFY_TIMEOUT_MS),
  };
}
