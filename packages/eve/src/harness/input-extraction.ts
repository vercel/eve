import type { ContentPart, ModelMessage, ToolSet, TypedToolCall } from "ai";

import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import type { InputRequest } from "#runtime/input/types.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/input-requests.js";

interface ToolCallDescriptor {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface PersistedToolCall extends ToolCallDescriptor {
  readonly type: "tool-call";
}

/**
 * Extracts question input requests from tool calls that target the
 * `ask_question` framework tool.
 */
export function extractQuestionInputRequests(input: {
  readonly excludedCallIds: ReadonlySet<string>;
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
}): InputRequest[] {
  return extractQuestionRequests(input);
}

function extractQuestionRequests(input: {
  readonly excludedCallIds: ReadonlySet<string>;
  readonly toolCalls: readonly ToolCallDescriptor[];
}): InputRequest[] {
  const requests: InputRequest[] = [];

  for (const toolCall of input.toolCalls) {
    if (toolCall.toolName !== ASK_QUESTION_TOOL_NAME) {
      continue;
    }

    if (input.excludedCallIds.has(toolCall.toolCallId)) {
      continue;
    }

    const action = createRuntimeToolCallActionFromToolCall({ toolCall });
    const toolInput = action.input as {
      allowFreeform?: boolean;
      options?: InputRequest["options"];
      prompt: string;
    };
    const request: {
      action: InputRequest["action"];
      allowFreeform?: InputRequest["allowFreeform"];
      display?: InputRequest["display"];
      options?: InputRequest["options"];
      prompt: InputRequest["prompt"];
      requestId: InputRequest["requestId"];
    } = {
      action,
      display: "text",
      prompt: String(toolInput.prompt),
      requestId: action.callId,
    };

    if (toolInput.allowFreeform !== undefined) {
      request.allowFreeform = toolInput.allowFreeform;
    }

    if (toolInput.options !== undefined) {
      request.options = toolInput.options;
      request.display = "select";
    }

    requests.push(request);
  }

  return requests;
}

/**
 * Extracts tool approval input requests from AI SDK content parts that
 * contain `tool-approval-request` entries.
 */
export function extractToolApprovalInputRequests(input: {
  readonly content: readonly ContentPart<ToolSet>[];
  readonly excludedCallIds?: ReadonlySet<string>;
}): InputRequest[] {
  return extractApprovalRequests(input);
}

// Persisted history parts lose AI SDK typing, so this core narrows each part
// at runtime. The exported wrapper above keeps live call sites compile-checked
// against the AI SDK shapes.
function extractApprovalRequests(input: {
  readonly content: readonly unknown[];
  readonly excludedCallIds?: ReadonlySet<string>;
  readonly includedRequestIds?: ReadonlySet<string>;
}): InputRequest[] {
  const requests: InputRequest[] = [];
  const toolCallsById = new Map<string, ToolCallDescriptor>();

  for (const part of input.content) {
    if (isPersistedToolCall(part)) {
      toolCallsById.set(part.toolCallId, part);
    }
  }

  for (const part of input.content) {
    if (!isToolApprovalRequest(part)) {
      continue;
    }

    if (input.includedRequestIds !== undefined && !input.includedRequestIds.has(part.approvalId)) {
      continue;
    }

    // AI SDK records automatic decisions as request/response pairs for history;
    // only unresolved requests should become eve input.
    if (part.isAutomatic === true) {
      continue;
    }
    const toolCall =
      (isToolCallDescriptor(part.toolCall) ? part.toolCall : undefined) ??
      (typeof part.toolCallId !== "string" ? undefined : toolCallsById.get(part.toolCallId));
    if (toolCall === undefined) {
      continue;
    }

    if (input.excludedCallIds?.has(toolCall.toolCallId)) {
      continue;
    }

    const action = createRuntimeToolCallActionFromToolCall({
      toolCall,
    });

    requests.push({
      action,
      allowFreeform: false,
      display: "confirmation",
      options: [
        { id: "approve", label: "Yes" },
        { id: "deny", label: "No" },
      ],
      prompt: `Approve tool call: ${toolCall.toolName}`,
      requestId: part.approvalId,
    });
  }

  return requests;
}

function isToolCallDescriptor(value: unknown): value is ToolCallDescriptor {
  return (
    isRecord(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    "input" in value
  );
}

function isPersistedToolCall(value: unknown): value is PersistedToolCall {
  return isRecord(value) && value.type === "tool-call" && isToolCallDescriptor(value);
}

function isToolApprovalRequest(value: unknown): value is {
  readonly approvalId: string;
  readonly isAutomatic?: unknown;
  readonly toolCall?: unknown;
  readonly toolCallId?: unknown;
  readonly type: "tool-approval-request";
} {
  return (
    isRecord(value) &&
    value.type === "tool-approval-request" &&
    typeof value.approvalId === "string"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/**
 * Recovers request metadata for submitted input response IDs from model
 * history. The newest occurrence wins so compacted or repeated history does
 * not replace the request that is closest to the current turn.
 */
export function extractHistoricalInputRequests(input: {
  readonly history: readonly ModelMessage[];
  readonly requestIds: ReadonlySet<string>;
}): ReadonlyMap<string, InputRequest> {
  const requests = new Map<string, InputRequest>();

  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const toolCalls = message.content
      .filter(isPersistedToolCall)
      .filter((toolCall) => input.requestIds.has(toolCall.toolCallId));
    const candidates = [
      ...extractQuestionRequests({ excludedCallIds: new Set(), toolCalls }),
      ...extractApprovalRequests({
        content: message.content,
        includedRequestIds: input.requestIds,
      }),
    ];

    for (const request of candidates) {
      if (!input.requestIds.has(request.requestId) || requests.has(request.requestId)) {
        continue;
      }

      requests.set(request.requestId, request);
    }

    if (requests.size === input.requestIds.size) {
      break;
    }
  }

  return requests;
}
