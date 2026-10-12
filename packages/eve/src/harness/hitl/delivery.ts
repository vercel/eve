import { openRequests } from "#protocol/session-reader.js";
import { withTypedBindings } from "#harness/response-bindings.js";
import type { UserContent } from "ai";

import { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/hitl/stale-responses.js";
import { firstOpenInteraction } from "#harness/first-open-interaction.js";
import type { HarnessStepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { readAnswerText } from "#internal/input-text.js";
import type { Answer } from "#shared/input.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { publicViewOf } from "#protocol/session-projection.js";

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
  readonly displayMessage?: string | UserContent;
  readonly takeQueued: boolean;
} {
  const queued = options.takeQueued ? view.turn.queued : undefined;
  const limit = openRequests(view.projection.view).find((row) => row.request.kind === "budget");
  // Match the new typed answer before queued messages join it.
  const incoming =
    queued !== undefined && limit !== undefined
      ? resolveTextInput({ requests: [limit] }, input)
      : input;
  const merged =
    queued === undefined
      ? incoming
      : incoming === undefined
        ? queued
        : coalesceTurnInputs(queued, incoming);
  // An approval settles on its own answer, before its batch resolves: the answer still counts
  // while its batch waits for the rest.
  const pendingRequestIds = new Set([
    ...ownOpenRequestIds(view),
    ...view.turn.suspended.flatMap((step) => step.requests.map((ask) => ask.interactionId)),
  ]);
  const tables = publicViewOf(view.projection);
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
 * The answer consumes the message and the context the channel sent about it: the model reads
 * neither.
 */
export function resolveTextInput(
  batch: { readonly requests: readonly InteractionRow[] },
  stepInput: HarnessStepInput | undefined,
): ResolvedStepInput | undefined {
  const text = readAnswerText(stepInput);
  if (stepInput === undefined || text === undefined) return stepInput;
  const batchRequestIds = new Set(batch.requests.map((row) => row.interactionId));
  if (stepInput.answers?.some((answer) => batchRequestIds.has(answer.interactionId))) {
    return stepInput;
  }
  const responses = resolveTextToResponses(text, batch.requests);
  if (responses.length === 0) return stepInput;
  return compactInput({
    ...stepInput,
    context: undefined,
    answers: [...(stepInput.answers ?? []), ...responses],
    message: undefined,
    messageConsumed: true,
    responseBindings: withTypedBindings(stepInput, responses),
  });
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
  const answered = new Set(
    [
      ...(stepInput.answers ?? []),
      ...(stepInput.attributedAnswers ?? []).map(({ response }) => response),
    ].map(({ interactionId }) => interactionId),
  );
  const first = firstOpenInteraction(view.projection, (interactionId) =>
    answered.has(interactionId),
  );
  const parked = view.turn.suspended.some((step) =>
    step.requests.some((ask) => ask.interactionId === first?.interactionId),
  );
  if (first === undefined || !parked || first.request.kind !== "approval") return stepInput;
  const response = resolveTextToResponse(text, first);
  if (response === undefined) return stepInput;
  return {
    ...stepInput,
    context: undefined,
    answers: [...(stepInput.answers ?? []), response],
    message: undefined,
    messageConsumed: true,
    responseBindings: withTypedBindings(stepInput, [response]),
  };
}

export function canonicalize(answers: readonly Answer[]): readonly Answer[] {
  const byInteraction = new Map<string, Answer>();
  for (const answer of answers) byInteraction.set(answer.interactionId, answer);
  return [...byInteraction.values()];
}

export function isEmptyInput(input: HarnessStepInput): boolean {
  return Object.keys(compactInput(input)).length === 0;
}

export function withoutResponses(
  input: ResolvedStepInput | undefined,
): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  const {
    attributedAnswers: _attributed,
    answers: _responses,
    responseBindings: _bindings,
    messageConsumed: _consumed,
    ...rest
  } = input;
  return rest;
}

/** The turn's own input: the message a plain-text answer didn't consume, and its context. */
export function turnInputOnly(input: ResolvedStepInput | undefined): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  const result: { context?: HarnessStepInput["context"]; message?: HarnessStepInput["message"] } =
    {};
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if (input.message !== undefined && input.messageConsumed !== true) result.message = input.message;
  const turnInput = attachClientContext(result, readClientContext(input));
  return isEmptyInput(turnInput) ? undefined : turnInput;
}

/** What of the input isn't the turn's: answers, and the output the session asks for. */
export function withoutTurnInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  const result: {
    answers?: HarnessStepInput["answers"];
    outputSchema?: HarnessStepInput["outputSchema"];
    attributedAnswers?: HarnessStepInput["attributedAnswers"];
    responseBindings?: HarnessStepInput["responseBindings"];
    deliveries?: HarnessStepInput["deliveries"];
  } = {};
  if ((input?.answers?.length ?? 0) > 0) result.answers = input!.answers;
  if ((input?.attributedAnswers?.length ?? 0) > 0)
    result.attributedAnswers = input!.attributedAnswers;
  if ((input?.responseBindings?.length ?? 0) > 0) result.responseBindings = input!.responseBindings;
  if ((input?.deliveries?.length ?? 0) > 0) result.deliveries = input!.deliveries;
  if (input?.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return result;
}

export function compactInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) return {};
  const result: {
    context?: HarnessStepInput["context"];
    answers?: HarnessStepInput["answers"];
    message?: HarnessStepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: HarnessStepInput["outputSchema"];
    attributedAnswers?: HarnessStepInput["attributedAnswers"];
    responseBindings?: HarnessStepInput["responseBindings"];
    deliveries?: HarnessStepInput["deliveries"];
    messageAuth?: HarnessStepInput["messageAuth"];
  } = {};
  if ((input.attributedAnswers?.length ?? 0) > 0)
    result.attributedAnswers = input.attributedAnswers;
  if ((input.responseBindings?.length ?? 0) > 0) result.responseBindings = input.responseBindings;
  if ((input.deliveries?.length ?? 0) > 0) result.deliveries = input.deliveries;
  if (input.messageAuth !== undefined) result.messageAuth = input.messageAuth;
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.answers?.length ?? 0) > 0) result.answers = input.answers;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return attachClientContext(result, readClientContext(input));
}
