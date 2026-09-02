import type { ModelMessage, UserContent } from "ai";

import { extractHistoricalInputRequests } from "#harness/input-extraction.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import { isSessionLimitContinuationRequestId } from "#harness/session-limit-continuation.js";
import type { HarnessToolMap, StepInput } from "#harness/types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

export function dropStaleSessionLimitContinuationResponses(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
}): StepInput | undefined {
  if (input.stepInput === undefined) return undefined;
  const responses = input.stepInput.inputResponses ?? [];
  const attributed = input.stepInput.attributedInputResponses ?? [];
  const keep = (requestId: string) =>
    input.pendingRequestIds.has(requestId) || !isSessionLimitContinuationRequestId(requestId);
  const retained = responses.filter((response) => keep(response.requestId));
  const retainedAttributed = attributed.filter(({ response }) => keep(response.requestId));
  if (retained.length === responses.length && retainedAttributed.length === attributed.length) {
    return input.stepInput;
  }
  const { attributedInputResponses: _a, inputResponses: _r, ...remaining } = input.stepInput;
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = remaining;
  if (retained.length > 0) result.inputResponses = retained;
  if (retainedAttributed.length > 0) result.attributedInputResponses = retainedAttributed;
  return result;
}

type StaleResponseConversion =
  | { readonly kind: "unchanged"; readonly stepInput?: StepInput }
  | {
      readonly kind: "converted";
      readonly displayMessage: string | UserContent;
      readonly stepInput: StepInput;
    };

export function convertStaleResponsesToUserMessage(input: {
  readonly history: readonly ModelMessage[];
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): StaleResponseConversion {
  if (input.stepInput === undefined) return { kind: "unchanged" };
  const responses = input.stepInput.inputResponses ?? [];
  const attributed = input.stepInput.attributedInputResponses ?? [];
  if (responses.length === 0 && attributed.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const currentResponses: InputResponse[] = [];
  const currentAttributed: NonNullable<StepInput["attributedInputResponses"]>[number][] = [];
  const staleResponses: InputResponse[] = [];
  for (const response of responses) {
    (input.pendingRequestIds.has(response.requestId) ? currentResponses : staleResponses).push(
      response,
    );
  }
  for (const entry of attributed) {
    if (input.pendingRequestIds.has(entry.response.requestId)) currentAttributed.push(entry);
    else staleResponses.push(entry.response);
  }
  if (staleResponses.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const requests = extractHistoricalInputRequests({
    history: input.history,
    requestIds: new Set(staleResponses.map((response) => response.requestId)),
    tools: input.tools,
  });
  const modelMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatModelMessage(staleResponses, requests),
  );
  const displayBase =
    typeof input.stepInput.message === "string" ? input.stepInput.message : undefined;
  const displayMessage = appendOptionalUserContent(
    displayBase,
    formatDisplayMessage(staleResponses, requests),
  );
  const { attributedInputResponses: _a, inputResponses: _r, ...remaining } = input.stepInput;
  const stepInput: { -readonly [K in keyof StepInput]: StepInput[K] } = {
    ...remaining,
    message: modelMessage,
  };
  if (currentResponses.length > 0) stepInput.inputResponses = currentResponses;
  if (currentAttributed.length > 0) stepInput.attributedInputResponses = currentAttributed;
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
    if (response.optionId !== undefined) responseDetails.optionId = response.optionId;
    if (option !== undefined) {
      const selectedOption: { description?: string; id: string; label: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description !== undefined) selectedOption.description = option.description;
      responseDetails.selectedOption = selectedOption;
    }
    if (response.text !== undefined) responseDetails.text = response.text;
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
      if (response.text !== undefined && response.text.length > 0) return response.text;
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
  if (normalizedExisting === undefined) return appended;
  return appendUserContent({ appended, existing: normalizedExisting });
}
