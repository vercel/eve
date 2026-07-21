import type { ModelMessage } from "ai";

import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  buildRejectedActionBatch,
  buildToolResponseParts,
  isApprovalRequest,
  recordApprovedTools,
  type RejectedActionBatch,
} from "#harness/input-approval.js";
export { getApprovedTools, isApprovalRequest } from "#harness/input-approval.js";
export type { RejectedActionBatch } from "#harness/input-approval.js";

import { coalesceTurnInputs } from "#harness/messages.js";
import { resolveSessionLimitContinuation } from "#harness/session-limit-continuation.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";

const PENDING_INPUT_BATCH_KEY = "eve.runtime.pendingInputBatch";
const DEFERRED_STEP_INPUT_KEY = "eve.runtime.deferredStepInput";
const SETTLED_INPUT_RESPONSES_KEY = "eve.runtime.settledInputResponses";
const MAX_SETTLED_INPUT_RESPONSES = 128;

/**
 * Stream-emit coordinates carried so a parked batch's resolution can attribute
 * its events to the turn and step that requested the input.
 */
export interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Serializable pending input batch stored on the session state.
 */
export interface PendingInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
}

type ResolvedInputSettlement = {
  readonly event: PendingInputBatchEvent;
  readonly request: InputRequest;
} & (
  | {
      readonly outcome: "responded";
      readonly response: InputResponse;
    }
  | {
      readonly outcome: "ignored";
    }
);

/**
 * Returns true when the step input carries user-facing turn input.
 */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) {
    return false;
  }

  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Deferred step input
// ---------------------------------------------------------------------------

/**
 * Merges any queued follow-up input into the current step input and clears it
 * from session state.
 *
 * Used when the harness has to process a pending tool-approval response first
 * and defer the user's new message to the next internal model step.
 */
export function consumeDeferredStepInput(input: {
  readonly input?: StepInput;
  readonly session: HarnessSession;
}): {
  readonly input?: StepInput;
  readonly session: HarnessSession;
} {
  const deferredInput = getDeferredStepInput(input.session);

  if (deferredInput === undefined) {
    return input;
  }

  const session = clearDeferredStepInput(input.session);

  if (input.input === undefined) {
    return {
      input: deferredInput,
      session,
    };
  }

  return {
    input: coalesceTurnInputs(deferredInput, input.input),
    session,
  };
}

/**
 * Returns true when the session carries queued follow-up input for the next
 * internal harness step.
 */
export function hasDeferredStepInput(session: HarnessSession): boolean {
  return getDeferredStepInput(session) !== undefined;
}

// ---------------------------------------------------------------------------
// Pending input resolution
// ---------------------------------------------------------------------------

/**
 * Resolves pending input at the start of a harness step.
 *
 * When the pending batch contains tool-approval requests and the step input
 * also carries a follow-up user message, the message is deferred to the next
 * internal harness step rather than appended to the current turn. This is
 * necessary because AI SDK cannot process tool-approval responses and a new
 * user message in the same request -- the approval must be resolved in
 * isolation first, and the user message replayed on the subsequent step via
 * {@link consumeDeferredStepInput}.
 */
export function resolvePendingInput(input: {
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const { stepInput } = input;
  let session = input.session;
  const baseHistory = [...(input.history ?? session.history)];

  const pendingBatch = getPendingInputBatch(session.state);

  // No pending batch -- pass through to the model call.
  if (pendingBatch === undefined) {
    return { outcome: "continue", messages: baseHistory, session };
  }

  // Pending batch exists -- only resolve if we have actual responses.
  const resolvedStepInput = resolveTextMessageInput(pendingBatch, stepInput);
  const responses = resolvedStepInput?.inputResponses ?? [];
  const resolvesApprovalBatch = pendingBatch.requests.some((request) => isApprovalRequest(request));

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  if (resolvesApprovalBatch && hasUnansweredApproval({ pendingBatch, responses })) {
    session = queueDeferredStepInput(session, compactStepInput(resolvedStepInput));
    return { deferredMessage: true, outcome: "unresolved", messages: baseHistory, session };
  }

  if (responses.length === 0 && resolvedStepInput?.message !== undefined) {
    // A follow-up message arrived for question-only input with no explicit
    // responses. Keep the existing question semantics: mark unanswered
    // question requests ignored so the model can continue with the message.
    const toolParts = buildToolResponseParts(pendingBatch, []);
    const messages: ModelMessage[] = [...baseHistory, ...pendingBatch.responseMessages];
    if (toolParts.length > 0) {
      messages.push({ content: toolParts, role: "tool" });
    }

    const rejectedActions = buildRejectedActionBatch(pendingBatch, []);
    session = clearPendingInputBatch(session);

    return {
      consumedMessage: resolvedStepInput?.messageConsumed,
      inputSettlements: buildInputSettlements(pendingBatch, []),
      outcome: "resolved",
      messages,
      rejectedActions,
      session,
    };
  }

  const inputSettlements = buildInputSettlements(pendingBatch, responses);
  const limitContinuation = resolveSessionLimitContinuation({
    requests: pendingBatch.requests,
    responses,
  });

  session = recordSettledInputResponses(session, responses);

  // Record approved tools before clearing the batch.
  session = recordApprovedTools({
    pendingBatch,
    resolveApprovalKey: input.resolveApprovalKey,
    responses,
    session,
  });

  // Build tool result messages from responses.
  const toolParts = buildToolResponseParts(pendingBatch, responses);

  const messages: ModelMessage[] = [...baseHistory, ...pendingBatch.responseMessages];
  if (toolParts.length > 0) {
    messages.push({ content: toolParts, role: "tool" });
  }

  const rejectedActions = buildRejectedActionBatch(pendingBatch, responses);
  session = clearPendingInputBatch(session);

  // AI SDK collects approval responses only from the tail tool message.
  // Defer channel context and any follow-up message so the approval resolves
  // in isolation; `consumeDeferredStepInput` replays them on the next step.
  if (resolvesApprovalBatch) {
    const deferredInput: {
      context?: StepInput["context"];
      message?: StepInput["message"];
    } = {};
    if ((resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = resolvedStepInput?.context;
    }
    if (resolvedStepInput?.message !== undefined) {
      deferredInput.message = resolvedStepInput.message;
    }

    if (deferredInput.context !== undefined || deferredInput.message !== undefined) {
      session = queueDeferredStepInput(session, deferredInput);

      return {
        consumedMessage: resolvedStepInput?.messageConsumed,
        deferredContext: deferredInput.context === undefined ? undefined : true,
        deferredMessage: deferredInput.message === undefined ? undefined : true,
        inputSettlements,
        limitContinuation,
        outcome: "resolved",
        messages,
        rejectedActions,
        session,
      };
    }
  }

  return {
    consumedMessage: resolvedStepInput?.messageConsumed,
    inputSettlements,
    limitContinuation,
    outcome: "resolved",
    messages,
    rejectedActions,
    session,
  };
}

function buildInputSettlements(
  pendingBatch: PendingInputBatch,
  responses: readonly InputResponse[],
): readonly ResolvedInputSettlement[] | undefined {
  const event = pendingBatch.event;
  if (event === undefined) {
    return undefined;
  }

  const responsesByRequestId = new Map(
    responses.map((response) => [response.requestId, response] as const),
  );
  return pendingBatch.requests.map((request): ResolvedInputSettlement => {
    const response = responsesByRequestId.get(request.requestId);
    return response === undefined
      ? { event, outcome: "ignored", request }
      : { event, outcome: "responded", request, response };
  });
}

function resolveTextMessageInput(
  pendingBatch: PendingInputBatch,
  stepInput: StepInput | undefined,
): (StepInput & { readonly messageConsumed?: boolean }) | undefined {
  if (typeof stepInput?.message !== "string" || (stepInput.inputResponses?.length ?? 0) > 0) {
    return stepInput;
  }

  const responses = resolveTextToResponses(stepInput.message, pendingBatch.requests);
  if (responses.length === 0) {
    return stepInput;
  }

  return compactStepInput({
    ...stepInput,
    inputResponses: responses,
    messageConsumed: true,
    message: undefined,
  });
}

function compactStepInput(
  input: (StepInput & { readonly messageConsumed?: boolean }) | undefined,
): StepInput & { readonly messageConsumed?: boolean } {
  if (input === undefined) {
    return {};
  }

  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};

  if ((input.context?.length ?? 0) > 0) {
    result.context = input.context;
  }
  if ((input.inputResponses?.length ?? 0) > 0) {
    result.inputResponses = input.inputResponses;
  }
  if (input.message !== undefined) {
    result.message = input.message;
  }
  if (input.messageConsumed === true) {
    result.messageConsumed = true;
  }
  if (input.outputSchema !== undefined) {
    result.outputSchema = input.outputSchema;
  }

  return result;
}

function hasUnansweredApproval(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly responses: readonly InputResponse[];
}): boolean {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  return input.pendingBatch.requests.some(
    (request) => isApprovalRequest(request) && !responseIds.has(request.requestId),
  );
}

type ResolvePendingInputResult = {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  /**
   * Present when the resolved batch answered a session-limit continuation
   * prompt. The tool loop grants a fresh token budget window or terminates
   * the session based on `granted`.
   */
  readonly inputSettlements?: readonly ResolvedInputSettlement[];
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: RejectedActionBatch;
  readonly session: HarnessSession;
};

// ---------------------------------------------------------------------------
// Pending batch management
// ---------------------------------------------------------------------------

/**
 * Returns true when the session is parked on a pending HITL batch
 * (tool approvals or `ask_question` prompts).
 */
export function hasPendingInputBatch(state: SessionStateMap | undefined): boolean {
  return getPendingInputBatch(state) !== undefined;
}

/**
 * Returns the request IDs in the currently pending HITL batch.
 */
export function getPendingInputRequestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(getPendingInputBatch(state)?.requests.map((request) => request.requestId));
}

export function discardSettledInputResponseRetries(input: {
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): {
  readonly discarded: number;
  readonly stepInput?: StepInput;
} {
  const responses = input.stepInput?.inputResponses;
  if (responses === undefined || responses.length === 0) {
    return { discarded: 0, stepInput: input.stepInput };
  }

  const settledResponses = getSettledInputResponses(input.session.state);
  const retainedResponses = responses.filter(
    (response) =>
      !settledResponses.some((settledResponse) => inputResponsesEqual(settledResponse, response)),
  );
  const discarded = responses.length - retainedResponses.length;
  if (discarded === 0) {
    return { discarded, stepInput: input.stepInput };
  }

  return {
    discarded,
    stepInput: {
      ...input.stepInput,
      inputResponses: retainedResponses,
    },
  };
}

function getPendingInputBatch(state: SessionStateMap | undefined): PendingInputBatch | undefined {
  const value = state?.[PENDING_INPUT_BATCH_KEY];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const batch = value as PendingInputBatch;

  if (!Array.isArray(batch.requests) || !Array.isArray(batch.responseMessages)) {
    return undefined;
  }

  return batch;
}

/**
 * Stores one pending HITL batch on the session until the user responds.
 */
export function setPendingInputBatch(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const state = { ...input.session.state };
  state[PENDING_INPUT_BATCH_KEY] = {
    event: input.event,
    requests: [...input.requests],
    responseMessages: [...input.responseMessages],
  } satisfies PendingInputBatch;

  return { ...input.session, state };
}

function clearPendingInputBatch(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_INPUT_BATCH_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[PENDING_INPUT_BATCH_KEY];

  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/** Records accepted responses in the bounded durable retry-deduplication ledger. */
export function recordSettledInputResponses(
  session: HarnessSession,
  responses: readonly InputResponse[],
): HarnessSession {
  if (responses.length === 0) return session;

  const responseIds = new Set(responses.map((response) => response.requestId));
  const retained = getSettledInputResponses(session.state).filter(
    (response) => !responseIds.has(response.requestId),
  );
  const state = { ...session.state };
  state[SETTLED_INPUT_RESPONSES_KEY] = [...retained, ...responses]
    .slice(-MAX_SETTLED_INPUT_RESPONSES)
    .map((response) => ({ ...response }));
  return { ...session, state };
}

function getSettledInputResponses(state: SessionStateMap | undefined): readonly InputResponse[] {
  const responses = state?.[SETTLED_INPUT_RESPONSES_KEY];
  return Array.isArray(responses) ? (responses as readonly InputResponse[]) : [];
}

function inputResponsesEqual(left: InputResponse, right: InputResponse): boolean {
  return (
    left.requestId === right.requestId &&
    left.optionId === right.optionId &&
    left.text === right.text
  );
}

// ---------------------------------------------------------------------------
// Deferred step input state
// ---------------------------------------------------------------------------

function getDeferredStepInput(session: HarnessSession): StepInput | undefined {
  return session.state?.[DEFERRED_STEP_INPUT_KEY] as StepInput | undefined;
}

function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession {
  const existing = getDeferredStepInput(session);
  const deferredInput = existing === undefined ? input : coalesceTurnInputs(existing, input);
  const state = { ...session.state };
  state[DEFERRED_STEP_INPUT_KEY] = deferredInput;

  return {
    ...session,
    state,
  };
}

function clearDeferredStepInput(session: HarnessSession): HarnessSession {
  if (session.state?.[DEFERRED_STEP_INPUT_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[DEFERRED_STEP_INPUT_KEY];

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

/**
 * Creates a runtime tool-call action shape from an AI SDK tool call.
 */
export function createRuntimeToolCallActionFromToolCall(input: {
  readonly toolCall: {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  };
}): RuntimeToolCallActionRequest {
  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}

function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  try {
    return parseJsonObject(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}
