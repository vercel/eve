import type { ContentPart, ToolSet } from "ai";
import { z } from "#compiled/zod/index.js";

import { projectToolStartLabel } from "#harness/action-presentation.js";
import type { InputRequest } from "#shared/input.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import type { HarnessToolLookup } from "#harness/types.js";
import { displayTitle } from "#shared/display-name.js";

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
 * Extracts tool approval input requests from AI SDK content parts that
 * contain `tool-approval-request` entries. Each prompt names the call by the
 * label its entry in `tools` gives it.
 */
export function extractToolApprovalInputRequests(input: {
  readonly content: readonly ContentPart<ToolSet>[];
  readonly excludedCallIds?: ReadonlySet<string>;
  readonly tools: HarnessToolLookup;
}): InputRequest[] {
  return extractApprovalRequests(input);
}

// Persisted history parts lose AI SDK typing, so this core narrows each part
// at runtime. The exported wrapper above keeps live call sites compile-checked
// against the AI SDK shapes.
function extractApprovalRequests(input: {
  readonly content: readonly unknown[];
  readonly excludedCallIds?: ReadonlySet<string>;
  readonly tools: HarnessToolLookup;
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

    const action = createRuntimeToolCallActionFromToolCall({ toolCall });
    const tool = input.tools.get(action.toolName);
    const toolInput =
      typeof toolCall.input === "object" &&
      toolCall.input !== null &&
      !Array.isArray(toolCall.input)
        ? (toolCall.input as Record<string, unknown>)
        : {};
    const toolApproval = tool?.approval;
    const prompt =
      toolApproval === undefined || typeof toolApproval === "function"
        ? undefined
        : toolApproval.prompt?.({
            callId: toolCall.toolCallId,
            input: toolInput,
            toolName: toolCall.toolName,
          });
    if (prompt !== undefined && typeof prompt !== "string") {
      throw new Error(`Tool "${toolCall.toolName}" approval prompt must return a string.`);
    }
    const label = projectToolStartLabel(tool, action.input) ?? displayTitle(action.toolName);

    requests.push({
      action,
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: prompt ?? `Approve ${label}?`,
      requestId: approval.approvalId,
    });
  }

  return requests;
}
