import {
  getInvalidToolCallInputError,
  isInvalidToolCall,
} from "#harness/tool-call-input-errors.js";
import type { ModelMessage, ToolSet, TypedToolCall, TypedToolResult } from "ai";

import { isWorkflowTool } from "#execution/tasks/model-step.js";
import { historyCallNames } from "#harness/execute-call.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { InlineCallResults } from "#harness/call-executor.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { isRunnableTool } from "#harness/tools.js";
import type { HarnessToolLookup } from "#harness/types.js";

type StepResponseMessage = HarnessStepResult["response"]["messages"][number];
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

export function withCallResults(input: {
  readonly stepResult: HarnessStepResult;
  readonly responseMessages: readonly StepResponseMessage[];
  readonly calls: InlineCallResults;
  readonly answers: readonly ToolResultPart[];
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
}): HarnessStepResult {
  const { calls, stepResult } = input;
  return {
    approvalRequests: calls.approvals,
    policyApprovals: calls.policyApprovals,
    content: stepResult.content,
    finishReason: stepResult.finishReason,
    ...(input.invalidInputToolCallIds === undefined
      ? {}
      : { invalidInputToolCallIds: input.invalidInputToolCallIds }),
    providerMetadata: stepResult.providerMetadata,
    response: {
      ...stepResult.response,
      messages: appendMissingToolResultMessages({
        append: [...calls.parts, ...input.answers],
        responseMessages: input.responseMessages,
      }),
    },
    signIns: calls.signIns,
    text: stepResult.text,
    toolCalls: stepResult.toolCalls,
    toolResults: [
      ...((stepResult.toolResults ?? []) as TypedToolResult<ToolSet>[]),
      ...calls.toolResults,
    ],
    usage: stepResult.usage,
  };
}

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

export function appendMissingToolResultMessages(input: {
  readonly append: readonly ToolResultPart[];
  readonly responseMessages: readonly StepResponseMessage[];
}): StepResponseMessage[] {
  const existingCallIds = extractToolResultCallIds(input.responseMessages);
  const callNames = historyCallNames(input.responseMessages);
  const append = input.append
    .filter((part) => !existingCallIds.has(part.toolCallId))
    .map((part) => ({ ...part, toolName: callNames.get(part.toolCallId) ?? part.toolName }));
  if (append.length === 0) return [...input.responseMessages];

  const last = input.responseMessages.at(-1);
  const answered = last?.role === "tool" ? last : undefined;
  const order = new Map<string, number>();
  for (const message of input.responseMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && !order.has(part.toolCallId)) {
        order.set(part.toolCallId, order.size);
      }
    }
  }
  const position = (part: ToolResponsePart) =>
    (part.type === "tool-result" ? order.get(part.toolCallId) : undefined) ?? order.size;
  const content = [...(answered?.content ?? []), ...append].sort(
    (a, b) => position(a) - position(b),
  );
  return [
    ...(answered === undefined ? input.responseMessages : input.responseMessages.slice(0, -1)),
    { role: "tool", content },
  ];
}

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

function isLocalOrWorkflowTool(definition: HarnessToolDefinition | undefined): boolean {
  return isRunnableTool(definition) || isWorkflowTool(definition);
}

export function answerSkippedToolCalls(
  step: HarnessStepResult,
  tools: HarnessToolLookup,
  excludedCallIds: ReadonlySet<string>,
): ToolResultPart[] {
  const { finishReason } = step;
  if (finishReason === "stop" || finishReason === "tool-calls") return [];
  const value = `The tool did not run because the model response ended early (finish reason: ${finishReason}). Call the tool again if you still need its result.`;
  return ((step.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter(
      (toolCall) =>
        isLocalOrWorkflowTool(tools.get(toolCall.toolName)) &&
        toolCall.providerExecuted !== true &&
        !isInvalidToolCall(toolCall) &&
        getInvalidToolCallInputError({ toolCall }) === undefined &&
        !excludedCallIds.has(toolCall.toolCallId),
    )
    .map((toolCall) => ({
      output: { type: "error-text", value },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      type: "tool-result",
    }));
}
