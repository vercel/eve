import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { getApprovedTools } from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
import { clearPendingSessionLimitPrompt } from "#harness/hitl/session-limit-input-requests.js";
import type { HarnessSession, StepInput } from "#harness/types.js";

export { getApprovedTools, clearPendingSessionLimitPrompt };
export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
export {
  appendPendingInputBatch,
  consumeDeferredStepInput,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingInputBatch,
} from "#harness/pending-input-batches.js";

/** Returns true when the step input carries user-facing turn input. */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Returns true when any pending batch still contains a tool approval. */
export function hasPendingApprovalBatch(session: HarnessSession): boolean {
  return getPendingInputBatches(session.state).some((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
}

/** Resolves one delivery through the authoritative HITL request interpreter. */
export { interpretRequestDelivery as resolvePendingInput } from "#harness/hitl/request-interpreter.js";

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
