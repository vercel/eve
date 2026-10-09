import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { SettledCall } from "#harness/session-machine/transitions.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

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

/**
 * What the model reads when a call's tool went away before the call could run.
 * `searchable` says whether the agent has `eve__search` to find another.
 */
export function unavailableToolMessage(toolName: string, searchable: boolean): string {
  const next = searchable
    ? `find an available tool with ${SEARCH_TOOL_NAME} and make a new call`
    : "make a new call with an available tool";
  return `The tool "${toolName}" is no longer available, so the call didn't run. If the task still needs it, ${next}.`;
}

/**
 * A call that ends without running: its failed runtime result, which the lifecycle reports at the
 * step's coordinates, and the `error-text` result the model reads.
 */
export function failedCall(call: {
  readonly callId: string;
  readonly message: string;
  readonly toolName: string;
}): Required<Pick<SettledCall, "part" | "result">> {
  const { callId, message, toolName } = call;
  return {
    part: {
      output: { type: "error-text", value: message },
      toolCallId: callId,
      toolName,
      type: "tool-result",
    },
    result: createRuntimeToolResultFromValue({ callId, isError: true, output: message, toolName }),
  };
}
