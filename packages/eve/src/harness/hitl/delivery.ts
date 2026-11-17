import type { MessageContent } from "#shared/message-content.js";
import { openRequests, promptQueueHead } from "#protocol/session-projection/reader.js";

import { answerFromText } from "#channel/resolve-text.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/hitl/stale-responses.js";
import type { HarnessStepInput, SubmittedAnswer } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { readAnswerText } from "#internal/input-text.js";
import type { Answer } from "#shared/input.js";
import type { SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import { ownOpenRequestIds } from "#harness/session-machine/view.js";
import type { SessionView } from "#harness/session-machine/view.js";

export function deliver(
  view: SessionView,
  input: HarnessStepInput | undefined,
  options: { readonly takeQueued: boolean; readonly typedAnswers?: boolean },
): {
  readonly input?: HarnessStepInput;
  readonly displayMessage?: MessageContent;
  readonly takeQueued: boolean;
} {
  const queued = options.takeQueued ? view.turn.queued : undefined;
  const limit = openRequests(view.projection.view).find((row) => row.request.kind === "budget");
  const incoming =
    queued !== undefined && limit !== undefined && options.typedAnswers !== false
      ? resolveTextInput(view.projection.view, input)
      : input;
  const merged =
    queued === undefined
      ? incoming
      : incoming === undefined
        ? queued
        : coalesceTurnInputs(queued, incoming);
  const tables = view.projection.view;
  const pendingRequestIds = new Set([
    ...ownOpenRequestIds(view),
    ...view.turn.suspended.flatMap((step) =>
      step.requests
        .filter((ask) => tables.interactions[ask.interactionId] === undefined)
        .map((ask) => ask.interactionId),
    ),
  ]);
  const converted = convertStaleResponsesToUserMessage({
    pendingRequestIds,
    view: tables,
    stepInput: dropStaleSessionLimitContinuationResponses({ pendingRequestIds, stepInput: merged }),
  });
  return converted.kind === "converted"
    ? {
        displayMessage: converted.displayMessage,
        input: converted.stepInput,
        takeQueued: options.takeQueued,
      }
    : { input: converted.stepInput, takeQueued: options.takeQueued };
}

export type ResolvedStepInput = HarnessStepInput & { readonly messageConsumed?: boolean };

export function resolveTextInput(
  view: SessionTables,
  stepInput: HarnessStepInput | undefined,
): ResolvedStepInput | undefined {
  const text = readAnswerText(stepInput);
  if (stepInput === undefined || text === undefined) return stepInput;
  const batchRequestIds = new Set(openRequests(view).map((row) => row.interactionId));
  if (stepInput.answers?.some((answer) => batchRequestIds.has(answer.interactionId))) {
    return stepInput;
  }
  const first = promptQueueHead(view);
  const response = first === undefined ? undefined : answerFromText(text, first);
  const answers = typedAnswers(stepInput, response === undefined ? [] : [response]);
  if (answers === undefined) return stepInput;
  return compactInput(consumeTypedMessage(stepInput, answers));
}

export function resolveTypedApproval(
  view: Pick<SessionView, "projection" | "turn">,
  stepInput: HarnessStepInput | undefined,
): ResolvedStepInput | undefined {
  const text = readAnswerText(stepInput);
  if (stepInput === undefined || text === undefined) return stepInput;
  const answered = new Set((stepInput.answers ?? []).map(({ interactionId }) => interactionId));
  const first = promptQueueHead(view.projection.view, (interactionId) =>
    answered.has(interactionId),
  );
  const parked = view.turn.suspended.some((step) =>
    step.requests.some((ask) => ask.interactionId === first?.interactionId),
  );
  if (first === undefined || !parked || first.request.kind !== "approval") return stepInput;
  const response = answerFromText(text, first);
  const answers = typedAnswers(stepInput, response === undefined ? [] : [response]);
  if (answers === undefined) return stepInput;
  return consumeTypedMessage(stepInput, answers);
}

function consumeTypedMessage(
  input: HarnessStepInput,
  answers: readonly SubmittedAnswer[],
): ResolvedStepInput {
  return {
    ...input,
    answers: [...(input.answers ?? []), ...answers],
    context: undefined,
    deliveries: withoutHistory(input.deliveries),
    history: undefined,
    message: undefined,
    messageConsumed: true,
  };
}

function withoutHistory(
  deliveries: HarnessStepInput["deliveries"],
): HarnessStepInput["deliveries"] {
  return deliveries?.map(({ history: _history, ...delivery }) => delivery);
}

function typedAnswers(
  input: HarnessStepInput,
  answers: readonly Answer[],
): readonly SubmittedAnswer[] | undefined {
  const deliveryId = input.deliveries?.at(-1)?.deliveryId;
  if (deliveryId === undefined || answers.length === 0) return undefined;
  return answers.map((answer, index) => ({
    ...answer,
    deliveryId,
    responseId: typedResponseId(deliveryId, index),
  }));
}

export function typedResponseId(deliveryId: string, index: number): string {
  return `response_${deliveryId}_typed_${String(index)}`;
}

export function isEmptyInput(input: HarnessStepInput): boolean {
  return Object.keys(compactInput(input)).length === 0;
}

export function withoutResponses(
  input: ResolvedStepInput | undefined,
): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  const { answers: _answers, messageConsumed: _consumed, ...rest } = input;
  return rest;
}

export function turnInputOnly(input: ResolvedStepInput | undefined): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  const result: {
    context?: HarnessStepInput["context"];
    history?: HarnessStepInput["history"];
    message?: HarnessStepInput["message"];
  } = {};
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.history?.length ?? 0) > 0) result.history = input.history;
  if (input.message !== undefined && input.messageConsumed !== true) result.message = input.message;
  const turnInput = attachClientContext(result, readClientContext(input));
  return isEmptyInput(turnInput) ? undefined : turnInput;
}

export function withoutTurnInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  const result: {
    answers?: HarnessStepInput["answers"];
    outputSchema?: HarnessStepInput["outputSchema"];
    deliveries?: HarnessStepInput["deliveries"];
  } = {};
  if ((input?.answers?.length ?? 0) > 0) result.answers = input!.answers;
  if ((input?.deliveries?.length ?? 0) > 0) result.deliveries = input!.deliveries;
  if (input?.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return result;
}

export function compactInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) return {};
  const result: {
    context?: HarnessStepInput["context"];
    history?: HarnessStepInput["history"];
    answers?: HarnessStepInput["answers"];
    message?: HarnessStepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: HarnessStepInput["outputSchema"];
    deliveries?: HarnessStepInput["deliveries"];
  } = {};
  if ((input.deliveries?.length ?? 0) > 0) result.deliveries = input.deliveries;
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.history?.length ?? 0) > 0) result.history = input.history;
  if ((input.answers?.length ?? 0) > 0) result.answers = input.answers;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return attachClientContext(result, readClientContext(input));
}
