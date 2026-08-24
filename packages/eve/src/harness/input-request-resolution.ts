import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatchEvent } from "#harness/pending-input-batches.js";
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

export function buildResolvedInputBatch(
  batch: {
    readonly event?: PendingInputBatchEvent;
    readonly requests: readonly InputRequest[];
  },
  responses: readonly InputResponse[],
): ResolvedInputBatch | undefined {
  if (batch.event === undefined) return undefined;
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  return {
    event: batch.event,
    inputs: batch.requests.map((request) => {
      const response = responseMap.get(request.requestId);
      return {
        outcome: isApprovalRequest(request)
          ? resolveApprovalOutcome(response).status
          : response === undefined
            ? "ignored"
            : "answered",
        request,
        response,
      };
    }),
  };
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
