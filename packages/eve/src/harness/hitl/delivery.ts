import type { UserContent } from "ai";
import { openInputs } from "#protocol/session-projection.js";

import { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/hitl/stale-responses.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { firstOpenInput } from "#harness/open-input-request.js";
import type { StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { readAnswerText } from "#internal/input-text.js";
import type { InputResponse } from "#shared/input.js";
import type { SuspendedStep } from "#harness/session-machine/state.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
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
  input: StepInput | undefined,
  options: { readonly takeQueued: boolean },
): {
  readonly input?: StepInput;
  readonly displayMessage?: string | UserContent;
  readonly takeQueued: boolean;
} {
  const queued = options.takeQueued ? view.turn.queued : undefined;
  const limit = openInputs(view.projection).find((entry) => entry.request.kind === "session-limit");
  // Match the new typed answer before queued messages join it.
  const incoming =
    queued !== undefined && limit !== undefined
      ? resolveTextInput({ requests: [limit.request] }, input)
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
    ...view.turn.suspended.flatMap((step) => step.requests.map((request) => request.requestId)),
  ]);
  const known = new Map(
    Object.values(view.projection.inputs).map((entry) => [entry.request.requestId, entry.request]),
  );
  const converted = convertStaleResponsesToUserMessage({
    pendingRequestIds,
    requests: known,
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

export type ResolvedStepInput = StepInput & { readonly messageConsumed?: boolean };

/**
 * Plain text answers a budget prompt; `resolveTypedApproval` answers approvals. A channel
 * that wraps the typed text in an envelope for the model attaches the text itself to answer with.
 * The answer consumes the message and the context the channel sent about it: the model reads
 * neither.
 */
export function resolveTextInput(
  batch: Pick<SuspendedStep, "requests">,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  const text = readAnswerText(stepInput);
  if (stepInput === undefined || text === undefined) return stepInput;
  const batchRequestIds = new Set(batch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }
  const responses = resolveTextToResponses(text, batch.requests);
  if (responses.length === 0) return stepInput;
  return compactInput({
    ...stepInput,
    context: undefined,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    message: undefined,
    messageConsumed: true,
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
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  const text = readAnswerText(stepInput);
  if (stepInput === undefined || text === undefined) return stepInput;
  const answered = new Set(
    [
      ...(stepInput.inputResponses ?? []),
      ...(stepInput.attributedInputResponses ?? []).map(({ response }) => response),
    ].map(({ requestId }) => requestId),
  );
  const first = firstOpenInput(view.projection, (requestId) => answered.has(requestId))?.request;
  const parked = view.turn.suspended.some((step) =>
    step.requests.some((request) => request.requestId === first?.requestId),
  );
  if (first === undefined || !parked || !isApprovalRequest(first)) return stepInput;
  const response = resolveTextToResponse(text, first);
  if (response === undefined) return stepInput;
  return {
    ...stepInput,
    context: undefined,
    inputResponses: [...(stepInput.inputResponses ?? []), response],
    message: undefined,
    messageConsumed: true,
  };
}

export function canonicalize(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

export function hasInput(input: StepInput | undefined): boolean {
  return input?.message !== undefined || (input?.inputResponses?.length ?? 0) > 0;
}

export function isEmptyInput(input: StepInput): boolean {
  return Object.keys(compactInput(input)).length === 0;
}

export function withoutResponses(input: ResolvedStepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const {
    attributedInputResponses: _attributed,
    inputResponses: _responses,
    messageConsumed: _consumed,
    ...rest
  } = input;
  return rest;
}

/** The turn's own input: the message a plain-text answer didn't consume, and its context. */
export function turnInputOnly(input: ResolvedStepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const result: { context?: StepInput["context"]; message?: StepInput["message"] } = {};
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if (input.message !== undefined && input.messageConsumed !== true) result.message = input.message;
  const turnInput = attachClientContext(result, readClientContext(input));
  return isEmptyInput(turnInput) ? undefined : turnInput;
}

/** What of the input isn't the turn's: answers, and the output the session asks for. */
export function withoutTurnInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  const result: {
    inputResponses?: StepInput["inputResponses"];
    outputSchema?: StepInput["outputSchema"];
  } = {};
  if ((input?.inputResponses?.length ?? 0) > 0) result.inputResponses = input!.inputResponses;
  if (input?.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return result;
}

export function compactInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) return {};
  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return attachClientContext(result, readClientContext(input));
}
