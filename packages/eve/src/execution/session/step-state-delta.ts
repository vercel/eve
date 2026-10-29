import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { followInterruptedAttempt, readOrphanedLines } from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { diffValue, snapshotValue } from "#shared/value-delta.js";
import {
  readHistoryBoundaries,
  retainHistoryBoundaries,
  writeHistoryBoundaries,
} from "#execution/session/history-boundaries.js";

// Steps only: the workflow body applies what this returns with `applySessionStateDelta`, and
// can't import the session's publication.

const SESSION_VALUE_KEYS = ["serializedContext", "sessionState", "history"] as const;

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
>(input: I, work: (input: I) => Promise<R>): Promise<WithSessionStateDelta<R>>;
export async function withSessionStateDelta(
  input: Partial<SessionStateValues>,
  work: (input: Partial<SessionStateValues>) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const base = Object.fromEntries(
    SESSION_VALUE_KEYS.map((key) => [key, snapshotValue(input[key])]),
  );
  const { sessionWritable } = input as { readonly sessionWritable?: WritableStream<Uint8Array> };
  if (sessionWritable !== undefined && base.sessionState !== undefined) {
    const checkpoint = base.sessionState as DurableSessionState;
    const session = readDurableSession(checkpoint);
    await readOrphanedLines({
      sessionId: checkpoint.sessionId,
      position: storedProjection(session.state).view.position,
      sessionWritable,
    });
  }
  const { serializedContext, sessionState, history, ...result } = await work(input);
  let candidateState = sessionState ?? (base.sessionState as DurableSessionState | undefined);
  // Every history-changing step participates, not only turn steps: cancellation and recovery
  // can change history too. New boundaries are added by the turn step after its turn settles.
  if (Array.isArray(base.history) && history !== undefined && candidateState !== undefined) {
    const previousState = (base.sessionState as DurableSessionState | undefined)?.snapshot.session
      .state;
    const previous = readHistoryBoundaries(previousState);
    const nextState = candidateState.snapshot.session.state;
    const proposed = readHistoryBoundaries(nextState);
    const proposedIds = new Set(proposed.map((boundary) => boundary.turnId));
    const retained = retainHistoryBoundaries(
      previous,
      base.history.length,
      diffValue(base.history, history),
    ).filter((boundary) => proposedIds.has(boundary.turnId));
    const knownIds = new Set(previous.map((boundary) => boundary.turnId));
    const added = proposed.filter(
      (boundary) => !knownIds.has(boundary.turnId) && boundary.length <= history.length,
    );
    if (previous.length > 0 || proposed.length > 0) {
      candidateState = {
        ...candidateState,
        snapshot: {
          ...candidateState.snapshot,
          session: {
            ...candidateState.snapshot.session,
            state: writeHistoryBoundaries(nextState, [...retained, ...added]),
          },
        },
      };
    }
  }
  const next = {
    serializedContext,
    sessionState:
      candidateState === undefined || sessionWritable === undefined
        ? candidateState
        : followInterruptedAttempt(sessionWritable, candidateState),
    history,
  };
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  for (const key of SESSION_VALUE_KEYS) {
    const delta = next[key] === undefined ? undefined : diffValue(base[key], next[key]);
    if (delta !== undefined) stateDelta[key] = delta;
  }
  return { ...result, stateDelta };
}
