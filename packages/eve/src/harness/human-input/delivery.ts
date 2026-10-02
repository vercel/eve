import type { UserContent } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/human-input/stale-responses.js";
import type { StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
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
  const merged =
    queued === undefined ? input : input === undefined ? queued : coalesceTurnInputs(queued, input);
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

/** Plain text answers the only pending batch, unless a response policy must decide it. */
export function resolveTextInput(
  batch: Pick<SuspendedStep, "requests" | "responseAuthRequiredRequestIds">,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;
  const batchRequestIds = new Set(batch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }
  const policyDecides = new Set(batch.responseAuthRequiredRequestIds ?? []);
  const responses = resolveTextToResponses(
    stepInput.message,
    batch.requests.filter((request) => !policyDecides.has(request.requestId)),
  );
  if (responses.length === 0) return stepInput;
  return compactInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    message: undefined,
    messageConsumed: true,
  });
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
