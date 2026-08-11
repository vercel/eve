import type { ModelMessage } from "ai";

import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvePendingInputResult,
  ToolResponsePart,
} from "#harness/pending-input-resolution.js";

export type QuestionInputRequest = InputRequest & { readonly kind: "question" };

export function resolveQuestionOnlyInputBatches(
  input: InputDomainResolverInput,
): ResolvePendingInputResult {
  const resolvedBatches = findAnsweredQuestionBatches(input.batches, input.responses);
  const openBatches = input.batches.filter((batch) => !resolvedBatches.includes(batch));
  const leftoverResponses = responsesForBatches(input.responses, openBatches);

  if (resolvedBatches.length === 0) {
    if (input.resolvedStepInput?.message === undefined) {
      return {
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }

    const sole = input.batches.length === 1 ? input.batches[0] : undefined;
    if (sole === undefined) {
      const session =
        leftoverResponses.length === 0
          ? input.session
          : queueDeferredStepInput(input.session, { inputResponses: leftoverResponses });
      return {
        consumedMessage: input.resolvedStepInput.messageConsumed,
        outcome: "continue",
        messages: [...input.baseHistory],
        session,
      };
    }

    // One question-only batch keeps the dismiss-and-continue behavior.
    const messages = resolveQuestionBatches({
      batches: [sole],
      messages: [...input.baseHistory],
      responses: [],
    });
    return {
      consumedMessage: input.resolvedStepInput.messageConsumed,
      outcome: "resolved",
      messages,
      session: removePendingInputBatches(input.session, [sole]),
    };
  }

  const messages = resolveQuestionBatches({
    batches: resolvedBatches,
    messages: [...input.baseHistory],
    responses: input.responses,
  });

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput,
    leftoverResponses,
    messages,
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(input.session, resolvedBatches),
  });
}

export function findAnsweredQuestionBatches(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
): PendingInputBatch[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.some((request) => responseIds.has(request.requestId)),
  );
}

export function resolveQuestionBatches(input: {
  readonly batches: readonly PendingInputBatch[];
  readonly messages: ModelMessage[];
  readonly responses: readonly InputResponse[];
}): ModelMessage[] {
  const responseMap = new Map(input.responses.map((response) => [response.requestId, response]));
  for (const batch of input.batches) {
    const toolParts = batch.requests.map((request) =>
      buildQuestionToolResponsePart(
        request as QuestionInputRequest,
        responseMap.get(request.requestId),
      ),
    );
    appendResolvedBatchTranscript(input.messages, batch, toolParts);
  }

  return input.messages;
}

export function buildQuestionToolResponsePart(
  request: QuestionInputRequest,
  response: InputResponse | undefined,
): ToolResponsePart {
  return {
    output: {
      type: "json",
      value:
        response !== undefined
          ? { optionId: response.optionId, text: response.text, status: "answered" }
          : { status: "ignored" },
    },
    toolCallId: request.action.callId,
    toolName: request.action.toolName,
    type: "tool-result",
  };
}
