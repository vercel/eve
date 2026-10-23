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

// How a delivery reaches `answer`: queued input joins it, stale answers turn into text, and a
// plain-text answer becomes the response it stands for.

/**
 * The delivery a step answers with: input queued behind earlier work joins it, unless the
 * runtime still runs calls (queued input waits for them). A stale answer, to a request that
 * already closed, never authorizes anything: a stale session-limit answer is dropped, and
 * any other becomes plain text the model reads.
 */
export function deliver(
  view: SessionView,
  input: HarnessStepInput | undefined,
  options: { readonly takeQueued: boolean },
): {
  readonly input?: HarnessStepInput;
  readonly displayMessage?: MessageContent;
  readonly takeQueued: boolean;
} {
  const queued = options.takeQueued ? view.turn.queued : undefined;
  const limit = openRequests(view.projection.view).find((row) => row.request.kind === "budget");
  // Match the new typed answer before queued messages join it.
  const incoming =
    queued !== undefined && limit !== undefined
      ? resolveTextInput(view.projection.view, input)
      : input;
  const merged =
    queued === undefined
      ? incoming
      : incoming === undefined
        ? queued
        : coalesceTurnInputs(queued, incoming);
  // An approval settles on its own answer, before its batch resolves: the answer still counts
  // while its batch waits for the rest.
  const tables = view.projection.view;
  // An approval not asked yet, behind its step's tasks, still takes its answer.
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

/**
 * Plain text answers a budget prompt; `resolveTypedApproval` answers approvals. A channel
 * that wraps the typed text in an envelope for the model attaches the text itself to answer with.
 * The answer consumes the message, with the context and history the channel sent with it: the
 * model reads none of them.
 */
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

/**
 * Turns a typed reply into a response to the first open request when that request is one of
 * this turn's approvals. The approval coordinator then settles it, or asks its response policy
 * about the person who typed, as it does for a press. A batch's other approvals stay open for
 * later replies.
 */
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

/** A message consumed as an answer imports nothing, so its deliveries record no history. */
function withoutHistory(
  deliveries: HarnessStepInput["deliveries"],
): HarnessStepInput["deliveries"] {
  return deliveries?.map(({ history: _history, ...delivery }) => delivery);
}

/**
 * The answers a typed message stands for, submitted from the delivery that carried it, so they
 * keep one identity through coalescing and policy passes as a press does. Text that arrived in
 * no delivery answers nothing.
 */
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

/** The turn's own input: the message a plain-text answer didn't consume, and its context. */
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

/** What of the input isn't the turn's: answers, and the output the session asks for. */
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
