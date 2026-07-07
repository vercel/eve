import type { ContentPart, ToolApprovalRequestOutput, ToolSet, TypedToolCall } from "ai";

import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import type { InputRequest } from "#runtime/input/types.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/input-requests.js";

/**
 * Extracts question input requests from tool calls that target the
 * `ask_question` framework tool.
 */
export function extractQuestionInputRequests(input: {
  readonly excludedCallIds: ReadonlySet<string>;
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
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
  const requests: InputRequest[] = [];
  const toolCallsById = new Map<string, TypedToolCall<ToolSet>>();

  for (const part of input.content) {
    if (part.type === "tool-call") {
      toolCallsById.set(part.toolCallId, part);
    }
  }

  for (const part of input.content) {
    if (part.type !== "tool-approval-request") {
      continue;
    }

    const approvalRequest = part as ToolApprovalRequestOutput<ToolSet> & {
      readonly toolCall?: TypedToolCall<ToolSet>;
      readonly toolCallId?: string;
    };
    // AI SDK records automatic decisions as request/response pairs for history;
    // only unresolved requests should become eve input.
    if (approvalRequest.isAutomatic === true) {
      continue;
    }
    const toolCall =
      approvalRequest.toolCall ??
      (approvalRequest.toolCallId === undefined
        ? undefined
        : toolCallsById.get(approvalRequest.toolCallId));
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
      requestId: approvalRequest.approvalId,
    });
  }

  return requests;
}
