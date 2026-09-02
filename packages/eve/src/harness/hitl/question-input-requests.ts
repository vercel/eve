import type { ModelMessage } from "ai";

import type { InputRequest, InputResponse } from "#shared/input.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import type {
  RequestVerdict,
  RequestVerdictReducerInput,
  ToolResponsePart,
} from "#harness/hitl/request-verdict.js";
import { appendResolvedBatchTranscript } from "#harness/hitl/pending-input-resolution.js";

export type QuestionInputRequest = InputRequest & { readonly kind: "question" };

export function findAnsweredQuestionBatches(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
): PendingInputBatch[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.some((request) => responseIds.has(request.requestId)),
  );
}

export function reduceQuestionRequestVerdict(input: RequestVerdictReducerInput): RequestVerdict {
  const messages = [...input.messages];
  const responseMap = new Map(input.responses.map((response) => [response.requestId, response]));
  const toolParts = input.batch.requests.map((request) =>
    buildQuestionToolResponsePart(
      request as QuestionInputRequest,
      responseMap.get(request.requestId),
    ),
  );
  appendResolvedBatchTranscript(messages, input.batch, toolParts);

  return {
    messages,
    session: input.session,
  };
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

export function appendQuestionBatchTranscripts(input: {
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
