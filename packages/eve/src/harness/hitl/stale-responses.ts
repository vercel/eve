import { appendMessage, normalizeMessage } from "#harness/messages.js";
import type { MessageContent } from "#shared/message-content.js";
import { isSessionLimitContinuationRequestId } from "#harness/hitl/budget-request.js";
import type { HarnessStepInput } from "#harness/types.js";
import { askedCall } from "#protocol/session-reader.js";
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

/**
 * Filter pass: removes stale answers to session-limit continuation prompts
 * from the step input before any stale handling runs.
 *
 * These are dropped rather than converted: surfacing a stale "Stop" as
 * conversational prose would read fail-open, and a stale grant must not
 * extend any budget — a currently pending prompt (if any) stays parked and
 * re-raises. Stripping the responses also keeps them from resolving (and
 * clearing) a pending batch they never answered. Answers to a currently
 * pending continuation prompt pass through untouched.
 */
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

/**
 * Transformation pass: a response is stale when its request ID is not in
 * the currently pending HITL batch — the request was already answered,
 * cleared by a follow-up message, or cancelled.
 *
 * Responses for pending requests stay structured; stale responses become
 * plain user-message text. A stale response never reaches structured HITL
 * processing, so a stale approval cannot authorize an earlier tool call.
 * Request details the session still knows are best-effort model context.
 *
 * Assumes {@link dropStaleSessionLimitContinuationResponses} already ran:
 * stale continuation answers must never reach this conversion.
 */
export function convertStaleResponsesToUserMessage(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  /** The session's tables: the requests it still knows, closed ones included. */
  readonly view: SessionView;
  readonly stepInput?: HarnessStepInput;
}): StaleResponseConversion {
  if (input.stepInput === undefined) return { kind: "unchanged" };
  const answers = input.stepInput.answers ?? [];
  const currentResponses = answers.filter(({ interactionId }) =>
    input.pendingRequestIds.has(interactionId),
  );
  const staleResponses = answers.filter(
    ({ interactionId }) => !input.pendingRequestIds.has(interactionId),
  );
  if (staleResponses.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const { view } = input;
  const modelMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatModelMessage(staleResponses, view),
  );
  const displayMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatDisplayMessage(staleResponses, view),
  );
  const { answers: _answers, ...rest } = input.stepInput;
  const stepInput: HarnessStepInput =
    currentResponses.length === 0
      ? { ...rest, message: modelMessage }
      : { ...rest, answers: currentResponses, message: modelMessage };

  return { displayMessage, kind: "converted", stepInput };
}

function formatModelMessage(responses: readonly Answer[], view: SessionView): string {
  const resolvedResponses = responses.map((response) => {
    const row = view.interactions[response.interactionId];
    const request = row?.request;
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
      requestType?: "approval";
      response: typeof responseDetails;
      toolName?: string;
    } = { requestId: response.interactionId, response: responseDetails };
    if (row !== undefined && row.request.kind === "approval") {
      resolved.prompt = row.request.prompt;
      resolved.requestType = "approval";
      // The prompt is display text; the model needs the tool's real name.
      const toolName = askedCall(view, row)?.name;
      if (toolName !== undefined) resolved.toolName = toolName;
    }

    return resolved;
  });

  // A response without known metadata may still answer an approval, so the notice always applies.
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
