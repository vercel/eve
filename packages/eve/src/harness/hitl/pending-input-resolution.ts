import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { PendingInputBatch, PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import { queueDeferredStepInput } from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";

export type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];

/** Action results from one resolved batch, attributed to their originating turn. */
export interface ResolvedInputActionBatch {
  readonly event: PendingInputBatchEvent;
  readonly results: readonly RuntimeToolResultActionResult[];
}

export type ResolvedStepInput = StepInput & { readonly messageConsumed?: boolean };

export type InputDomainResolverInput = {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
};

export type ResolvePendingInputResult = {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  /** Present when a session-limit continuation prompt was resolved. */
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly session: HarnessSession;
};

export function responsesForBatches(
  responses: readonly InputResponse[],
  batches: readonly PendingInputBatch[],
): readonly InputResponse[] {
  return responses.filter((response) =>
    batches.some((batch) =>
      batch.requests.some((request) => request.requestId === response.requestId),
    ),
  );
}

export function appendResolvedBatchTranscript(
  messages: ModelMessage[],
  batch: PendingInputBatch,
  toolParts: readonly ToolResponsePart[],
): void {
  messages.push(...batch.responseMessages);
  if (toolParts.length > 0) {
    messages.push({ content: [...toolParts], role: "tool" });
  }
}

export function finishResolvedInput(input: {
  readonly deferTurnInput: boolean;
  readonly leftoverResponses: readonly InputResponse[];
  readonly limitContinuation?: { readonly granted: boolean };
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  // AI SDK collects approval responses only from the tail tool message. Turn
  // input must replay after that isolated approval response.
  const deferredInput: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
  } = {};
  if (input.leftoverResponses.length > 0) {
    deferredInput.inputResponses = input.leftoverResponses;
  }
  if (input.deferTurnInput) {
    if ((input.resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = input.resolvedStepInput?.context;
    }
    if (input.resolvedStepInput?.message !== undefined) {
      deferredInput.message = input.resolvedStepInput.message;
    }
  }

  if (Object.keys(deferredInput).length > 0) {
    return {
      consumedMessage: input.resolvedStepInput?.messageConsumed,
      deferredContext: deferredInput.context === undefined ? undefined : true,
      deferredMessage: deferredInput.message === undefined ? undefined : true,
      limitContinuation: input.limitContinuation,
      outcome: "resolved",
      messages: input.messages,
      rejectedActions: input.rejectedActions,
      session: queueDeferredStepInput(input.session, deferredInput),
    };
  }

  return {
    consumedMessage: input.resolvedStepInput?.messageConsumed,
    limitContinuation: input.limitContinuation,
    outcome: "resolved",
    messages: input.messages,
    rejectedActions: input.rejectedActions,
    session: input.session,
  };
}

export function compactStepInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) {
    return {};
  }

  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};

  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;

  return result;
}
