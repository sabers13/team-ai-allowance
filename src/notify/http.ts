import type { NotificationChannel } from "../contracts.ts";

/**
 * One small HTTP POST channel. Teams, Slack and the generic webhook differ only
 * in URL and payload, so they share this sender.
 *
 * A delivery result carries a status code and a short error class, never the
 * URL and never a response body that could echo it.
 */

export interface HttpSendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export async function postJson(
  url: string,
  payload: unknown,
  options: { timeoutMs: number; fetchImpl?: typeof fetch } = { timeoutMs: 5000 },
): Promise<HttpSendResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // Drain the body so the connection is reusable; do not keep or log it.
    await response.arrayBuffer().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, error: null };
    }
    return { ok: false, status: response.status, error: "non_2xx" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, status: null, error: name };
  }
}

export function isHttpChannel(channel: NotificationChannel): boolean {
  return channel === "teams" || channel === "slack" || channel === "webhook";
}
