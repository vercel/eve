import type { ModelMessage } from "ai";

import type { InputRequest, InputResponse } from "#shared/input.js";
import type { OpenRequestGroup, RequestOutcome } from "#harness/hitl/request-ledger.js";
import {
  appendResolvedBatchTranscript,
  type ReducerInput,
  type ReducerResult,
} from "#harness/hitl/request-interpreter.js";

export type QuestionInputRequest = InputRequest & { readonly kind: "question" };

export function findAnsweredQuestionBatches<
  T extends { readonly requests: readonly InputRequest[] },
>(batches: readonly T[], responses: readonly InputResponse[]): T[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.some((request) => responseIds.has(request.requestId)),
  );
}

export function reduceQuestionRequestVerdict(input: ReducerInput): ReducerResult {
  const messages = [...input.messages];
  const responseMap = new Map(input.responses.map((response) => [response.requestId, response]));
  const toolParts = input.group.requests.map((request) =>
    buildQuestionToolResponsePart(
      request as QuestionInputRequest,
      responseMap.get(request.requestId),
    ),
  );
  appendResolvedBatchTranscript(messages, input.group, toolParts);

  return {
    messages,
    outcomes: new Map(
      input.records
        .map((record) => [record.id, record.outcome] as const)
        .filter((entry): entry is readonly [string, RequestOutcome] => entry[1] !== undefined),
    ),
  };
}

export function buildQuestionToolResponsePart(
  request: QuestionInputRequest,
  response: InputResponse | undefined,
): Extract<ModelMessage, { role: "tool" }>["content"][number] {
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
  readonly groups: readonly OpenRequestGroup[];
  readonly messages: ModelMessage[];
  readonly responses: readonly InputResponse[];
}): ModelMessage[] {
  const responseMap = new Map(input.responses.map((response) => [response.requestId, response]));
  for (const group of input.groups) {
    const toolParts = group.requests.map((request) =>
      buildQuestionToolResponsePart(
        request as QuestionInputRequest,
        responseMap.get(request.requestId),
      ),
    );
    appendResolvedBatchTranscript(input.messages, group, toolParts);
  }

  return input.messages;
}
