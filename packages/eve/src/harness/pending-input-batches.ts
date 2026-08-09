import type { ModelMessage } from "ai";

import type { InputRequest } from "#runtime/input/types.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";

const PENDING_INPUT_BATCHES_KEY = "eve.runtime.pendingInputBatches";
/** Pre-collection singleton key; read once for sessions parked before the upgrade. */
const LEGACY_PENDING_INPUT_BATCH_KEY = "eve.runtime.pendingInputBatch";
const DEFERRED_STEP_INPUT_KEY = "eve.runtime.deferredStepInput";

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
 * Serializable pending input batch stored on the session state: one parked
 * assistant turn's requests plus its withheld model output.
 */
export interface PendingInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
}

/**
 * Returns true when the session holds at least one pending HITL batch
 * (tool approvals or `ask_question` prompts).
 */
export function hasPendingInputBatch(state: SessionStateMap | undefined): boolean {
  return getPendingInputBatches(state).length > 0;
}

/**
 * Returns the request IDs across every pending HITL batch.
 */
export function getPendingInputRequestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(
    getPendingInputBatches(state).flatMap((batch) =>
      batch.requests.map((request) => request.requestId),
    ),
  );
}

function coercePendingInputBatch(value: unknown): PendingInputBatch | undefined {
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
 * Reads the ordered pending batches. Sessions parked before the collection
 * shape carry the legacy singleton key; it reads as a one-element list and
 * is rewritten to the list shape on the next batch write.
 */
export function getPendingInputBatches(
  state: SessionStateMap | undefined,
): readonly PendingInputBatch[] {
  const value = state?.[PENDING_INPUT_BATCHES_KEY];
  if (Array.isArray(value)) {
    return value
      .map((entry) => coercePendingInputBatch(entry))
      .filter((batch): batch is PendingInputBatch => batch !== undefined);
  }

  const legacy = coercePendingInputBatch(state?.[LEGACY_PENDING_INPUT_BATCH_KEY]);
  return legacy === undefined ? [] : [legacy];
}

/**
 * Removes the given batches (matched by identity from a prior
 * {@link getPendingInputBatches} read) and keeps every other batch open.
 *
 * Removal is the only exported way to shrink the collection: a wholesale
 * setter would reintroduce the overwrite hazard the collection exists to
 * prevent — a writer clobbering batches it never resolved.
 */
export function removePendingInputBatches(
  session: HarnessSession,
  batches: readonly PendingInputBatch[],
): HarnessSession {
  const removed = new Set(batches);
  return setPendingInputBatches(
    session,
    getPendingInputBatches(session.state).filter((batch) => !removed.has(batch)),
  );
}

function setPendingInputBatches(
  session: HarnessSession,
  batches: readonly PendingInputBatch[],
): HarnessSession {
  const state = { ...session.state };
  delete state[LEGACY_PENDING_INPUT_BATCH_KEY];
  if (batches.length === 0) {
    delete state[PENDING_INPUT_BATCHES_KEY];
  } else {
    state[PENDING_INPUT_BATCHES_KEY] = batches.map((batch) => ({
      event: batch.event,
      requests: [...batch.requests],
      responseMessages: [...batch.responseMessages],
    }));
  }

  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * Appends one pending HITL batch for a parked assistant turn. Earlier
 * batches stay open and independently answerable.
 */
export function appendPendingInputBatch(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  return setPendingInputBatches(input.session, [
    ...getPendingInputBatches(input.session.state),
    {
      event: input.event,
      requests: input.requests,
      responseMessages: input.responseMessages,
    },
  ]);
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

function getDeferredStepInput(session: HarnessSession): StepInput | undefined {
  return session.state?.[DEFERRED_STEP_INPUT_KEY] as StepInput | undefined;
}

export function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession {
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
