/**
 * CLI inference from the API format the gateway recorded.
 *
 * This is never an observation of the process on the laptop. Claude Code
 * speaks Anthropic Messages, OpenCode the Responses API and Codex Chat
 * Completions, so the API shape is the best evidence the control service has.
 * Every label the console shows says "inferred" for that reason.
 */

import type { ApiFormat, UsageRow } from "../../contracts.ts";

export type CliId = "claude-code" | "opencode" | "codex" | "unknown";

export interface CliInference {
  id: CliId;
  label: string;
  apiFormat: ApiFormat;
}

const BY_FORMAT: Readonly<Record<ApiFormat, { id: CliId; label: string }>> = {
  anthropic_messages: { id: "claude-code", label: "Claude Code" },
  responses: { id: "opencode", label: "OpenCode" },
  chat_completions: { id: "codex", label: "Codex" },
  unknown: { id: "unknown", label: "Unknown" },
};

const ORDER: readonly CliId[] = ["claude-code", "opencode", "codex", "unknown"];

export function inferCli(apiFormat: ApiFormat | undefined): CliInference {
  const format = apiFormat ?? "unknown";
  const entry = BY_FORMAT[format];
  return { id: entry.id, label: entry.label, apiFormat: format };
}

export interface CliSummary {
  cli: CliInference;
  /** Requests behind the winning format, and requests with no format at all. */
  requests: number;
  /** True when more than one format appears in the rows. */
  mixed: boolean;
}

/** The most frequent format wins; a tie follows `ORDER`, never insertion order. */
export function summarizeCli(rows: readonly UsageRow[]): CliSummary {
  if (rows.length === 0) {
    return { cli: inferCli(undefined), requests: 0, mixed: false };
  }
  const counts = new Map<ApiFormat, number>();
  for (const row of rows) {
    const format = row.apiFormat ?? "unknown";
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }
  let winner: ApiFormat = "unknown";
  let winningCount = -1;
  for (const id of ORDER) {
    const format = formatOf(id);
    const count = counts.get(format) ?? 0;
    if (count > winningCount) {
      winner = format;
      winningCount = count;
    }
  }
  return {
    cli: inferCli(winner),
    requests: Math.max(0, winningCount),
    mixed: [...counts.values()].filter((count) => count > 0).length > 1,
  };
}

function formatOf(id: CliId): ApiFormat {
  switch (id) {
    case "claude-code":
      return "anthropic_messages";
    case "opencode":
      return "responses";
    case "codex":
      return "chat_completions";
    default:
      return "unknown";
  }
}

/** "Anthropic Messages", for the column tooltip. */
export const API_FORMAT_LABEL: Readonly<Record<ApiFormat, string>> = {
  anthropic_messages: "Anthropic Messages",
  responses: "Responses API",
  chat_completions: "Chat Completions",
  unknown: "No API format recorded",
};
