import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  enterSessionStep,
  followInterruptedAttempt,
  readOrphanedLines,
  type Entered,
} from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { diffValue, snapshotValue } from "#shared/value-delta.js";

// Steps only: the workflow body applies what this returns with `applySessionStateDelta`, and
// can't import the session's publication.

const SESSION_VALUE_KEYS = ["serializedContext", "sessionState", "history"] as const;

/** What a session step is given: its session values, and where it writes. */
type StepValues = Partial<SessionStateValues> & {
  readonly sessionWritable?: WritableStream<Uint8Array>;
};

/**
 * Runs a session step's work and returns its result with the session values
 * it produced replaced by their delta from the values the step was given.
 *
 * Workflow replay reads every step's output but no step's input, so a step
 * that returns only what changed keeps both replay and storage from carrying
 * the whole session once per step. The workflow body applies the delta to the
 * values it passed in; see `applySessionStateDelta`.
 *
 * The input is snapshotted before `work` runs because step code may edit it
 * in place, as a channel adapter does with its state. A retried step's state
 * follows every line its interrupted attempt wrote; see
 * {@link followInterruptedAttempt}.
 */
export async function withSessionStateDelta<
  I extends Partial<SessionStateValues>,
  R extends Partial<SessionStateValues>,
>(input: I, work: (step: Entered<I>) => Promise<R>): Promise<WithSessionStateDelta<R>>;
export async function withSessionStateDelta(
  input: StepValues,
  work: (step: Entered<StepValues>) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const base = Object.fromEntries(
    SESSION_VALUE_KEYS.map((key) => [key, snapshotValue(input[key])]),
  );
  // The step's entry: whether it runs again is decided here, once, for all it does.
  const step = enterSessionStep(input);
  const { sessionWritable } = step;
  if (sessionWritable !== undefined && base.sessionState !== undefined) {
    const checkpoint = base.sessionState as DurableSessionState;
    const session = readDurableSession(checkpoint);
    await readOrphanedLines({
      rerun: step.rerun,
      sessionId: checkpoint.sessionId,
      position: storedProjection(session.state).view.position,
      sessionWritable,
    });
  }
  const { serializedContext, sessionState, history, ...result } = await work(step);
  const candidateState = sessionState ?? base.sessionState;
  const next = {
    serializedContext,
    sessionState:
      candidateState === undefined || sessionWritable === undefined
        ? sessionState
        : followInterruptedAttempt(sessionWritable, candidateState as DurableSessionState),
    history,
  };
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  for (const key of SESSION_VALUE_KEYS) {
    const delta = next[key] === undefined ? undefined : diffValue(base[key], next[key]);
    if (delta !== undefined) stateDelta[key] = delta;
  }
  return { ...result, stateDelta };
}
