import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  dispatchPendingSessionEvents,
  type PendingSessionEventDispatch,
} from "#execution/publish-session-events.js";
import { diffValue, snapshotValue, type ValueDelta } from "#shared/value-delta.js";

// Runs inside steps only. The workflow body applies deltas through
// `SessionStateCursor`, so it never loads the publication this module imports.

/** The durable values a session workflow threads through its steps. */
export interface SessionStateValues {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** How a step changed the session's values; an absent value is unchanged. */
export interface SessionStateDelta {
  readonly serializedContext?: ValueDelta;
  readonly sessionState?: ValueDelta;
}

/** A step result the session workflow adopts through its state cursor. */
export interface SessionStateTransition {
  readonly stateDelta: SessionStateDelta;
  /**
   * How many of the pending dispatches the step was given it ran, in write
   * order. The cursor clears those once it adopts the result. Absent when the
   * step was given none.
   */
  readonly dispatchedPending?: number;
}

/** `T` with its session values replaced by the delta that produces them. */
export type WithSessionStateDelta<T> = T extends unknown
  ? Omit<T, keyof SessionStateValues> & SessionStateTransition
  : never;

/** What a session step is given: any of the session's values, and the dispatches it owes. */
type SessionStepInput = Partial<SessionStateValues> & {
  readonly pendingDispatches?: readonly PendingSessionEventDispatch[];
};

/**
 * Runs a session step's work and returns its result with the session values
 * it produced replaced by their delta from the values the step was given.
 *
 * Workflow replay reads every step's output but no step's input, so a step
 * that returns only what changed keeps both replay and storage from carrying
 * the whole session once per step. The workflow body applies the delta to the
 * values it passed in; see `SessionStateCursor`.
 *
 * The input is snapshotted before `work` runs because step code may edit it
 * in place, as a channel adapter does with its state.
 *
 * Pending dispatches run first, and `work` starts from the state they leave.
 * A retried step runs them again from the state it was given, so each
 * dispatch's changes reach committed state once.
 */
export async function withSessionStateDelta<
  I extends SessionStepInput,
  R extends Partial<SessionStateValues>,
>(input: I, work: (input: I) => Promise<R>): Promise<WithSessionStateDelta<R>>;
export async function withSessionStateDelta(
  input: SessionStepInput,
  work: (input: SessionStepInput) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const base = {
    serializedContext: snapshotValue(input.serializedContext),
    sessionState: snapshotValue(input.sessionState),
  };
  const pending = input.pendingDispatches ?? [];
  const dispatched = pending.length === 0 ? undefined : await dispatchPending(input, pending);
  const {
    // Values `work` leaves alone keep the changes the pending dispatches made.
    serializedContext = dispatched?.serializedContext,
    sessionState = dispatched?.sessionState,
    ...result
  } = await work(dispatched === undefined ? input : { ...input, ...dispatched });
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  const contextDelta =
    serializedContext === undefined
      ? undefined
      : diffValue(base.serializedContext, serializedContext);
  if (contextDelta !== undefined) stateDelta.serializedContext = contextDelta;
  const sessionDelta =
    sessionState === undefined ? undefined : diffValue(base.sessionState, sessionState);
  if (sessionDelta !== undefined) stateDelta.sessionState = sessionDelta;
  return pending.length === 0
    ? { ...result, stateDelta }
    : { ...result, dispatchedPending: pending.length, stateDelta };
}

/** Runs the step's pending dispatches; `work` then sees none left to run. */
async function dispatchPending(
  input: SessionStepInput,
  pending: readonly PendingSessionEventDispatch[],
): Promise<SessionStateValues & { readonly pendingDispatches: readonly [] }> {
  const { serializedContext, sessionState } = input;
  if (serializedContext === undefined || sessionState === undefined) {
    throw new Error(
      "A step given pending dispatches must also be given the session they belong to.",
    );
  }
  const dispatched = await dispatchPendingSessionEvents(
    { serializedContext, sessionState },
    pending,
  );
  return { ...dispatched, pendingDispatches: [] };
}
