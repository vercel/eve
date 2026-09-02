import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { getApprovedTools } from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import {
  consumeDeferredStepInput,
  hasDeferredStepInput,
} from "#harness/hitl/deferred-step-input.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  createRequests,
  hasOpenRequests,
  openRequestGroups,
  openRequestIds,
} from "#harness/hitl/request-ledger.js";
import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
import { clearPendingSessionLimitPrompt } from "#harness/hitl/session-limit-input-requests.js";
import type { HarnessSession, StepInput } from "#harness/types.js";

export {
  clearPendingSessionLimitPrompt,
  consumeDeferredStepInput,
  createRequests,
  getApprovedTools,
  hasDeferredStepInput,
  hasOpenRequests,
  openRequestIds,
};
export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";

/** Returns true when the step input carries user-facing turn input. */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Returns true when any pending group still contains a tool approval. */
export function hasPendingApprovalBatch(session: HarnessSession): boolean {
  return openRequestGroups(session.state).some((group) =>
    group.requests.some((request) => isApprovalRequest(request)),
  );
}

/** Creates a runtime tool-call action shape from an AI SDK tool call. */
export function createRuntimeToolCallActionFromToolCall(input: {
  readonly toolCall: {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  };
}): RuntimeToolCallActionRequest {
  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}
