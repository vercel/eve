import type { ModelMessage, UserContent } from "ai";

import { extractHistoricalInputRequests } from "#harness/input-extraction.js";
import { isApprovalRequest } from "#harness/input-requests.js";
import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";

type StaleResponseConversion =
  | {
      readonly kind: "unchanged";
      readonly stepInput?: StepInput;
    }
  | {
      readonly displayMessage: string | UserContent;
      readonly kind: "converted";
      readonly stepInput: StepInput;
    };

/**
 * A response is stale when its request ID is not in the currently pending
 * HITL batch: the request was already answered, cleared by a follow-up
 * message, or cancelled.
 *
 * Responses for pending requests stay structured; stale responses become
 * plain user-message text. A stale response never reaches structured HITL
 * processing, so a stale approval cannot authorize an earlier tool call.
 * Request details recovered from history are best-effort model context.
 */
export function convertStaleResponsesToUserMessage(input: {
  readonly history: readonly ModelMessage[];
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
}): StaleResponseConversion {
  const responses = input.stepInput?.inputResponses;
  if (input.stepInput === undefined || responses === undefined || responses.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const currentResponses: InputResponse[] = [];
  const staleResponses: InputResponse[] = [];
  for (const response of responses) {
    if (input.pendingRequestIds.has(response.requestId)) {
      currentResponses.push(response);
    } else {
      staleResponses.push(response);
    }
  }

  if (staleResponses.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const requests = extractHistoricalInputRequests({
    history: input.history,
    requestIds: new Set(staleResponses.map((response) => response.requestId)),
  });
  const modelMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatModelMessage(staleResponses, requests),
  );
  const displayMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatDisplayMessage(staleResponses, requests),
  );
  const { inputResponses: _responses, ...remainingInput } = input.stepInput;
  const stepInput: { -readonly [K in keyof StepInput]: StepInput[K] } = {
    ...remainingInput,
    message: modelMessage,
  };
  if (currentResponses.length > 0) {
    stepInput.inputResponses = currentResponses;
  }

  return { displayMessage, kind: "converted", stepInput };
}

function formatModelMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  const resolvedResponses = responses.map((response) => {
    const request = requests.get(response.requestId);
    const option = request?.options?.find((candidate) => candidate.id === response.optionId);

    const responseDetails: {
      optionId?: string;
      selectedOption?: { description?: string; id: string; label: string };
      text?: string;
    } = {};
    if (response.optionId !== undefined) {
      responseDetails.optionId = response.optionId;
    }
    if (option !== undefined) {
      const selectedOption: { description?: string; id: string; label: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description !== undefined) {
        selectedOption.description = option.description;
      }
      responseDetails.selectedOption = selectedOption;
    }
    if (response.text !== undefined) {
      responseDetails.text = response.text;
    }

    const resolved: {
      prompt?: string;
      requestId: string;
      requestType?: "approval" | "question";
      response: typeof responseDetails;
    } = { requestId: response.requestId, response: responseDetails };
    if (request !== undefined) {
      resolved.prompt = request.prompt;
      resolved.requestType = isApprovalRequest(request) ? "approval" : "question";
    }

    return resolved;
  });
  // Request metadata can be missing (compacted history, subagent-proxied
  // request), so a response without it may still be an approval: default to
  // including the notice.
  const mayIncludeApproval = responses.some((response) => {
    const request = requests.get(response.requestId);
    return request === undefined || isApprovalRequest(request);
  });
  const approvalNotice = mayIncludeApproval
    ? " This does not authorize an earlier action; request approval again if that action is still needed."
    : "";

  return [
    "The user submitted the following response to an earlier interactive prompt.",
    `Treat it as new input at the current point in the conversation and decide whether it is still relevant.${approvalNotice}`,
    JSON.stringify(resolvedResponses, null, 2),
  ].join("\n");
}

function formatDisplayMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  return responses
    .map((response) => {
      if (response.text !== undefined && response.text.length > 0) {
        return response.text;
      }

      const option = requests
        .get(response.requestId)
        ?.options?.find((candidate) => candidate.id === response.optionId);
      return option?.label ?? response.optionId ?? "Response to an earlier interactive prompt";
    })
    .join("\n");
}

function appendOptionalUserContent(
  existing: string | UserContent | undefined,
  appended: string,
): string | UserContent {
  const normalizedExisting = normalizeUserContent(existing);
  if (normalizedExisting === undefined) {
    return appended;
  }

  return appendUserContent({ appended, existing: normalizedExisting });
}
