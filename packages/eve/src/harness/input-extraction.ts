import type { ContentPart, ModelMessage, ToolSet, TypedToolCall } from "ai";
import { z } from "zod";

import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import type { InputRequest } from "#runtime/input/types.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/input-requests.js";

// Persisted history parts lose AI SDK typing on the storage round trip. The
// schemas are the single source for the runtime narrowing and the static
// types, so the checks and the annotations cannot drift apart.
const ToolCallDescriptorSchema = z.object({
  input: z.unknown(),
  toolCallId: z.string(),
  toolName: z.string(),
});

type ToolCallDescriptor = z.infer<typeof ToolCallDescriptorSchema>;

const PersistedToolCallSchema = ToolCallDescriptorSchema.extend({
  type: z.literal("tool-call"),
});

// Malformed optional metadata degrades to `undefined` instead of dropping the
// whole approval request: a broken `toolCall` falls back to the sibling
// tool-call lookup and a broken `isAutomatic` counts as not automatic.
const ToolApprovalRequestSchema = z.object({
  approvalId: z.string(),
  isAutomatic: z.boolean().optional().catch(undefined),
  toolCall: ToolCallDescriptorSchema.optional().catch(undefined),
  toolCallId: z.string().optional().catch(undefined),
  type: z.literal("tool-approval-request"),
});

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
    const toolCall = PersistedToolCallSchema.safeParse(part);
    if (toolCall.success) {
      toolCallsById.set(toolCall.data.toolCallId, toolCall.data);
    }
  }

  for (const part of input.content) {
    const parsed = ToolApprovalRequestSchema.safeParse(part);
    if (!parsed.success) {
      continue;
    }
    const approval = parsed.data;

    if (
      input.includedRequestIds !== undefined &&
      !input.includedRequestIds.has(approval.approvalId)
    ) {
      continue;
    }

    // AI SDK records automatic decisions as request/response pairs for history;
    // only unresolved requests should become eve input.
    if (approval.isAutomatic === true) {
      continue;
    }

    const toolCall =
      approval.toolCall ??
      (approval.toolCallId === undefined ? undefined : toolCallsById.get(approval.toolCallId));
    if (toolCall === undefined) {
      continue;
    }

    if (input.excludedCallIds?.has(toolCall.toolCallId)) {
      continue;
    }

    requests.push({
      action: createRuntimeToolCallActionFromToolCall({ toolCall }),
      allowFreeform: false,
      display: "confirmation",
      options: [
        { id: "approve", label: "Yes" },
        { id: "deny", label: "No" },
      ],
      prompt: `Approve tool call: ${toolCall.toolName}`,
      requestId: approval.approvalId,
    });
  }

  return requests;
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

    const toolCalls = message.content.flatMap((part: unknown) => {
      const toolCall = PersistedToolCallSchema.safeParse(part);
      return toolCall.success && input.requestIds.has(toolCall.data.toolCallId)
        ? [toolCall.data]
        : [];
    });
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
