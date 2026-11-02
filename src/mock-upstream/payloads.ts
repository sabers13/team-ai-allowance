/**
 * Wire shapes for the three APIs the mock upstream imitates.
 *
 * The builders are pure: they take the requested model and return a JSON body.
 * Nothing here reads a clock for cost, and no builder echoes request text, so
 * the mock cannot leak a prompt into a response by accident.
 */
import { MOCK_TEXT, MOCK_USAGE } from "./models.ts";

const CREATED_AT = 1_761_868_800; // 2025-11-01T00:00:00Z, fixed so responses are stable

export function chatCompletion(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: CREATED_AT,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: MOCK_TEXT },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: MOCK_USAGE.promptTokens,
      completion_tokens: MOCK_USAGE.completionTokens,
      total_tokens: MOCK_USAGE.totalTokens,
    },
  };
}

export function chatChunks(model: string, includeUsage: boolean): Array<Record<string, unknown>> {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: CREATED_AT, model };
  const chunks: Array<Record<string, unknown>> = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: MOCK_TEXT }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  if (includeUsage) {
    chunks.push({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: MOCK_USAGE.promptTokens,
        completion_tokens: MOCK_USAGE.completionTokens,
        total_tokens: MOCK_USAGE.totalTokens,
      },
    });
  }
  return chunks;
}

export function responsesResult(model: string): Record<string, unknown> {
  return {
    id: "resp_mock",
    object: "response",
    created_at: CREATED_AT,
    status: "completed",
    model,
    output: [
      {
        id: "msg_mock",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: MOCK_TEXT, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: MOCK_USAGE.promptTokens,
      output_tokens: MOCK_USAGE.completionTokens,
      total_tokens: MOCK_USAGE.totalTokens,
    },
  };
}

export function responsesEvents(
  model: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const response = responsesResult(model);
  const item = (response.output as Array<Record<string, unknown>>)[0] ?? {};
  return [
    { event: "response.created", data: { type: "response.created", response } },
    {
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: 0, item },
    },
    {
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    },
    {
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        delta: MOCK_TEXT,
      },
    },
    {
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        text: MOCK_TEXT,
      },
    },
    {
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        item_id: "msg_mock",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: MOCK_TEXT, annotations: [] },
      },
    },
    {
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: 0, item },
    },
    { event: "response.completed", data: { type: "response.completed", response } },
  ];
}

export function anthropicMessage(model: string): Record<string, unknown> {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: MOCK_USAGE.promptTokens,
      output_tokens: MOCK_USAGE.completionTokens,
    },
  };
}

export function anthropicEvents(
  model: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: MOCK_USAGE.promptTokens, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: MOCK_TEXT },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: MOCK_USAGE.completionTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}
