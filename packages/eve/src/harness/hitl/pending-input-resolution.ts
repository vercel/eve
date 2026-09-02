import type { ModelMessage } from "ai";

import type { InputResponse } from "#shared/input.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import { queueDeferredStepInput } from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import type { ResolvedInputActionBatch, ToolResponsePart } from "#harness/hitl/request-verdict.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import type { ReadyRequestGroupDeliveryTarget } from "#harness/hitl/request-ledger.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";

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
  readonly kind?: never;
  readonly consumedMessage?: boolean;
  /** Ready Group delivery being applied by its named owners. */
  readonly groupCompletionDelivery?: {
    readonly deliveryKey: string;
    readonly targets: readonly ReadyRequestGroupDeliveryTarget[];
  };
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  /** Present when a session-limit continuation prompt was resolved. */
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "ready" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly resolvedInputs?: readonly ResolvedInputBatch[];
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
  readonly resolvedInputs?: readonly ResolvedInputBatch[];
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
  let clientContext: readonly string[] | undefined;
  if (input.leftoverResponses.length > 0) {
    deferredInput.inputResponses = input.leftoverResponses;
  }
  if (input.deferTurnInput) {
    if ((input.resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = input.resolvedStepInput?.context;
    }
    const resolvedClientContext = readClientContext(input.resolvedStepInput);
    if ((resolvedClientContext?.length ?? 0) > 0) {
      clientContext = resolvedClientContext;
    }
    if (input.resolvedStepInput?.message !== undefined) {
      deferredInput.message = input.resolvedStepInput.message;
    }
  }
  attachClientContext(deferredInput, clientContext);

  if (Object.keys(deferredInput).length > 0) {
    return {
      consumedMessage: input.resolvedStepInput?.messageConsumed,
      deferredContext:
        deferredInput.context === undefined && readClientContext(deferredInput) === undefined
          ? undefined
          : true,
      deferredMessage: deferredInput.message === undefined ? undefined : true,
      limitContinuation: input.limitContinuation,
      outcome: "resolved",
      messages: input.messages,
      rejectedActions: input.rejectedActions,
      resolvedInputs: input.resolvedInputs,
      session: queueDeferredStepInput(input.session, deferredInput),
    };
  }

  return {
    consumedMessage: input.resolvedStepInput?.messageConsumed,
    limitContinuation: input.limitContinuation,
    outcome: "resolved",
    messages: input.messages,
    rejectedActions: input.rejectedActions,
    resolvedInputs: input.resolvedInputs,
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

  return attachClientContext(result, readClientContext(input));
}
