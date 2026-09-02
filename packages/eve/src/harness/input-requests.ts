import type { ModelMessage } from "ai";

import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { getApprovedTools } from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  hasSettledApprovalBatch,
  interpretPendingInput,
  translatePendingInputEffects,
} from "#harness/hitl/pending-input-interpreter.js";
import { getPendingInputBatches, queueDeferredStepInput } from "#harness/pending-input-batches.js";
import { compactStepInput } from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
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

/**
 * Resolves pending input at the start of a harness step.
 *
 * Ordered batches remain independently answerable. Session-limit prompts own
 * resolution while open; approval batches preserve AI SDK's tail-message
 * requirement; question-only batches retain dismiss-and-continue behavior.
 */
export function resolvePendingInput(input: {
  readonly deferMessagesWhileApprovalsPending?: boolean;
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const batches = getPendingInputBatches(input.session.state);
  if (batches.length === 0) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  const initialResponses = canonicalizeInputResponses(input.stepInput?.inputResponses ?? []);
  const initial = interpretPendingInput({
    batches,
    message: input.stepInput?.message !== undefined,
    responses: initialResponses,
  });
  const deferTurnInput = hasTailApprovalResponse(baseHistory);
  const textResolutionBatch =
    initial.groups.find((group) => group.kind === "limit")?.batch ??
    (batches.length === 1 ? batches[0] : undefined);
  const resolvedStepInput =
    textResolutionBatch === undefined
      ? input.stepInput
      : resolveTextMessageInput(textResolutionBatch, input.stepInput);
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);
  const interpretation = interpretPendingInput({
    batches,
    message: resolvedStepInput?.message !== undefined,
    responses,
  });

  if (
    interpretation.groups.some((group) => group.kind === "approval") &&
    input.deferMessagesWhileApprovalsPending === true &&
    resolvedStepInput?.message !== undefined &&
    !hasSettledApprovalBatch(interpretation)
  ) {
    return {
      deferredMessage: true,
      outcome: "unresolved",
      messages: baseHistory,
      session: queueDeferredStepInput(input.session, compactStepInput(resolvedStepInput)),
    };
  }

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const deferredInput = compactStepInput(resolvedStepInput);
    const session =
      deferredInput.context !== undefined || deferredInput.outputSchema !== undefined
        ? queueDeferredStepInput(input.session, deferredInput)
        : input.session;
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  return translatePendingInputEffects({
    baseHistory,
    batches,
    deferTurnInput,
    interpretation,
    resolveApprovalKey: input.resolveApprovalKey,
    resolvedStepInput,
    responses,
    session: input.session,
  });
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function hasTailApprovalResponse(messages: readonly ModelMessage[]): boolean {
  const tail = messages.at(-1);
  return (
    tail?.role === "tool" && tail.content.some((part) => part.type === "tool-approval-response")
  );
}

function resolveTextMessageInput(
  pendingBatch: PendingInputBatch,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;

  const batchRequestIds = new Set(pendingBatch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }

  const responseAuthRequired = new Set(pendingBatch.responseAuthRequiredRequestIds ?? []);
  const textRequests = pendingBatch.requests.filter(
    (request) => !responseAuthRequired.has(request.requestId),
  );
  const responses = resolveTextToResponses(stepInput.message, textRequests);
  if (responses.length === 0) return stepInput;

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
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
