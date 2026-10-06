import type { ModelMessage } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import { createActionResultEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

type ToolResultPart = Extract<
  Extract<ModelMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>;

const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";
export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE = "Invalid approval response.";

type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";

export interface ResolvedInputBatch {
  readonly event: PendingInputBatchEvent;
  readonly inputs: readonly {
    readonly outcome: "answered" | ApprovalTerminalStatus;
    readonly request: InputRequest;
    readonly response?: InputResponse;
  }[];
}

/**
 * One request's terminal outcome once its batch resolves: an approval's
 * decision, or whether a question received a response.
 */
export function resolveInputOutcome(
  kind: InputRequest["kind"],
  response: InputResponse | undefined,
): "answered" | ApprovalTerminalStatus {
  if (kind === "tool-approval") return resolveApprovalOutcome(response).status;
  return response === undefined ? "ignored" : "answered";
}

export function resolveApprovalOutcome(response: InputResponse | undefined): {
  readonly approved: boolean;
  readonly reason: string | undefined;
  readonly status: ApprovalTerminalStatus;
} {
  if (response === undefined) {
    return {
      approved: false,
      reason: IGNORED_INPUT_REASON,
      status: "ignored",
    };
  }

  if (response.optionId === "approve") {
    return {
      approved: true,
      reason: undefined,
      status: "approved",
    };
  }

  // ACP uses "deny" while harness-owned approval prompts use "cancel".
  if (response.optionId === "cancel" || response.optionId === "deny") {
    return {
      approved: false,
      reason: TOOL_EXECUTION_DENIED_MESSAGE,
      status: "denied",
    };
  }

  return {
    approved: false,
    reason: TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE,
    status: "invalid",
  };
}

/** What the model reads when an approved call's tool went away before the call could run. */
export function unavailableToolMessage(toolName: string): string {
  return `The approved tool "${toolName}" is no longer available, so the call didn't run. If the task still needs it, find an available tool with search and make a new call, which needs approval again.`;
}

/**
 * A call that ends without running: the failed action result the stream reports, and the
 * `error-text` result the model reads.
 */
export function failedCallResult(
  at: PendingInputBatchEvent,
  call: { readonly callId: string; readonly message: string; readonly toolName: string },
): { readonly event: UnstampedMessageStreamEvent; readonly part: ToolResultPart } {
  const { callId, message, toolName } = call;
  return {
    event: createActionResultEvent({
      ...at,
      result: createRuntimeToolResultFromValue({
        callId,
        isError: true,
        output: message,
        toolName,
      }),
    }),
    part: {
      output: { type: "error-text", value: message },
      toolCallId: callId,
      toolName,
      type: "tool-result",
    },
  };
}
