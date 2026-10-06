import {
  getInvalidToolCallInputError,
  isInvalidToolCall,
} from "#harness/tool-call-input-errors.js";
import type { ModelMessage, ToolSet, TypedToolCall, TypedToolResult } from "ai";

import type { HarnessStepResult } from "#harness/step-hooks.js";

type StepResponseMessage = HarnessStepResult["response"]["messages"][number];
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

export function withAccumulatedResponseMessages(input: {
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
  readonly responseMessages: readonly StepResponseMessage[];
  readonly stepResult: HarnessStepResult;
  readonly toolResults?: readonly TypedToolResult<ToolSet>[];
}): HarnessStepResult {
  const { stepResult } = input;

  /*
   * AI SDK `StepResult` fields are prototype getters, so spreading the
   * instance drops them. Materialize each field while replacing the final
   * step's messages with the SDK's accumulated response, which also contains
   * approval-resume results created before the model step.
   */
  return {
    content: stepResult.content,
    finishReason: stepResult.finishReason,
    ...(input.invalidInputToolCallIds === undefined
      ? {}
      : { invalidInputToolCallIds: input.invalidInputToolCallIds }),
    providerMetadata: stepResult.providerMetadata,
    response: {
      ...stepResult.response,
      messages: [...input.responseMessages],
    },
    text: stepResult.text,
    toolCalls: stepResult.toolCalls,
    toolResults: input.toolResults === undefined ? stepResult.toolResults : [...input.toolResults],
    usage: stepResult.usage,
  };
}

/** True when provider history still owes a result for any assistant tool call. */
export function hasUnansweredToolCall(messages: readonly ModelMessage[]): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      if (part.type === "tool-call") callIds.add(part.toolCallId);
      if (part.type === "tool-result") resultIds.add(part.toolCallId);
    }
  }

  for (const callId of callIds) {
    if (!resultIds.has(callId)) return true;
  }
  return false;
}

/**
 * Appends synthesized tool results for calls that have no result anywhere in
 * the step's response messages. Exported for its dedupe contract: a call
 * already answered — including provider-executed results the SDK keeps
 * inline in the assistant message — must never receive a second
 * `tool-result`, or the next Anthropic call rejects the history with
 * "each tool_use must have a single result".
 */
export function appendMissingToolResultMessages(input: {
  readonly append: readonly ToolResultPart[];
  readonly responseMessages: readonly StepResponseMessage[];
}): StepResponseMessage[] {
  const existingCallIds = extractToolResultCallIds(input.responseMessages);
  const append = input.append.filter((part) => !existingCallIds.has(part.toolCallId));

  return [
    ...input.responseMessages,
    ...(append.length > 0 ? [{ role: "tool" as const, content: [...append] }] : []),
  ] satisfies StepResponseMessage[];
}

/**
 * CallIds answered anywhere in the response messages. Scans every message
 * role: provider-executed tool results arrive inline in the *assistant*
 * message (the SDK only moves them to a `tool` message during provider
 * history normalization, which runs after the backfill paths), so a
 * tool-message-only scan would let a synthesized result duplicate them.
 */
export function extractToolResultCallIds(messages: readonly ModelMessage[]): ReadonlySet<string> {
  const callIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (typeof part === "object" && part !== null && part.type === "tool-result") {
        callIds.add(part.toolCallId);
      }
    }
  }

  return callIds;
}

export function answerSkippedToolCalls(step: HarnessStepResult, tools: ToolSet): ToolResultPart[] {
  const { finishReason } = step;
  if (finishReason === "stop" || finishReason === "tool-calls") return [];

  const answeredCallIds = extractToolResultCallIds(step.response.messages);
  const pendingApprovalCallIds = new Set(
    (step.content ?? []).flatMap((part) =>
      part.type === "tool-approval-request" && part.isAutomatic !== true
        ? [part.toolCall.toolCallId]
        : [],
    ),
  );
  const value = `The tool did not run because the model response ended early (finish reason: ${finishReason}). Call the tool again if you still need its result.`;
  return ((step.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter(
      (toolCall) =>
        tools[toolCall.toolName]?.execute !== undefined &&
        toolCall.providerExecuted !== true &&
        !isInvalidToolCall(toolCall) &&
        getInvalidToolCallInputError({ toolCall }) === undefined &&
        !answeredCallIds.has(toolCall.toolCallId) &&
        !pendingApprovalCallIds.has(toolCall.toolCallId),
    )
    .map((toolCall) => ({
      output: { type: "error-text", value },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      type: "tool-result",
    }));
}
