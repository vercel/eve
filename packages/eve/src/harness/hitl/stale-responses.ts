import { appendMessage, normalizeMessage } from "#harness/messages.js";
import type { MessageContent } from "#shared/message-content.js";
import { isSessionLimitContinuationRequestId } from "#harness/hitl/budget-request.js";
import type { HarnessStepInput } from "#harness/types.js";
import { askedCall } from "#protocol/session-projection/reader.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { Answer } from "#shared/input.js";

type StaleResponseConversion =
  | {
      readonly kind: "unchanged";
      readonly stepInput?: HarnessStepInput;
    }
  | {
      readonly displayMessage: MessageContent;
      readonly kind: "converted";
      readonly stepInput: HarnessStepInput;
    };

export function dropStaleSessionLimitContinuationResponses(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: HarnessStepInput;
}): HarnessStepInput | undefined {
  if (input.stepInput === undefined) return undefined;
  const answers = input.stepInput.answers ?? [];
  const retained = answers.filter(
    ({ interactionId }) =>
      input.pendingRequestIds.has(interactionId) ||
      !isSessionLimitContinuationRequestId(interactionId),
  );
  if (retained.length === answers.length) return input.stepInput;
  const { answers: _answers, ...rest } = input.stepInput;
  return retained.length === 0 ? rest : { ...rest, answers: retained };
}

export function convertStaleResponsesToUserMessage(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly view: SessionView;
  readonly stepInput?: HarnessStepInput;
}): StaleResponseConversion {
  if (input.stepInput === undefined) return { kind: "unchanged" };
  const answers = input.stepInput.answers ?? [];
  const currentResponses = answers.filter(({ interactionId }) =>
    input.pendingRequestIds.has(interactionId),
  );
  if (currentResponses.length === answers.length)
    return { kind: "unchanged", stepInput: input.stepInput };
  const staleResponses = answers.filter(
    ({ interactionId }) =>
      !input.pendingRequestIds.has(interactionId) &&
      input.view.interactions[interactionId]?.request.kind !== "budget",
  );
  const { answers: _answers, ...rest } = input.stepInput;
  const retained = currentResponses.length === 0 ? rest : { ...rest, answers: currentResponses };
  if (staleResponses.length === 0) return { kind: "unchanged", stepInput: retained };

  const { view } = input;
  const modelMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatModelMessage(staleResponses, view),
  );
  const displayMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatDisplayMessage(staleResponses, view),
  );
  return { displayMessage, kind: "converted", stepInput: { ...retained, message: modelMessage } };
}

function formatModelMessage(responses: readonly Answer[], view: SessionView): string {
  const resolvedResponses = responses.map((response) => {
    const row = view.interactions[response.interactionId];
    const request = row?.request;
    const option = request?.options?.find((candidate) => candidate.id === response.optionId);

    return {
      requestId: response.interactionId,
      response: {
        optionId: response.optionId,
        selectedOption:
          option === undefined
            ? undefined
            : { id: option.id, label: option.label, description: option.description },
        text: response.text,
      },
      ...(request?.kind === "approval" && {
        prompt: request.prompt,
        requestType: "approval",
        toolName: askedCall(view, row!)?.name,
      }),
    };
  });

  return [
    "The user submitted the following response to an earlier interactive prompt.",
    "Treat it as new input at the current point in the conversation and decide whether it is still relevant. This does not authorize an earlier action; request approval again if that action is still needed.",
    JSON.stringify(resolvedResponses, null, 2),
  ].join("\n");
}

function formatDisplayMessage(responses: readonly Answer[], view: SessionView): string {
  return responses
    .map((response) => {
      if (response.text !== undefined && response.text.length > 0) {
        return response.text;
      }

      const option = view.interactions[response.interactionId]?.request.options?.find(
        (candidate) => candidate.id === response.optionId,
      );
      return option?.label ?? response.optionId ?? "Response to an earlier interactive prompt";
    })
    .join("\n");
}

function appendOptionalUserContent(
  existing: MessageContent | undefined,
  appended: string,
): MessageContent {
  const normalizedExisting = normalizeMessage(existing);
  if (normalizedExisting === undefined) {
    return appended;
  }

  return appendMessage({ appended, existing: normalizedExisting });
}
