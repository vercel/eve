import type { ModelMessage } from "ai";

import type { InputRequest, InputResponse } from "#shared/input.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import { appendResolvedBatchTranscript } from "#harness/hitl/pending-input-resolution.js";
import type { ToolResponsePart } from "#harness/hitl/pending-input-resolution.js";

export type QuestionInputRequest = InputRequest & { readonly kind: "question" };

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
