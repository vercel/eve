import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { followInterruptedAttempt, readOrphanedLines } from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { produce } from "#compiled/@workflow/core/state.js";
import { workflowStateRefsEnabled } from "#execution/install-workflow-state-refs.js";
import { diffValue, snapshotValue } from "#shared/value-delta.js";

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
 * With `WORKFLOW_STATE_REFS=1`, each changed value is instead returned whole,
 * as a `workflow/state` `produce()` result of the value the step was given:
 * Workflow then stores the next step's input as a reference and this output as
 * only the change, and the workflow body adopts the value as given.
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
  // Stored values arrive frozen with state references; step code edits copies.
  const byReference = workflowStateRefsEnabled();
  const given = byReference
    ? {
        ...input,
        serializedContext: base.serializedContext as SessionStateValues["serializedContext"],
        sessionState: base.sessionState as SessionStateValues["sessionState"],
      }
    : input;
  const { serializedContext, sessionState, history, ...result } = await work(given);
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
    const value = next[key];
    if (value === undefined) continue;
    if (byReference) {
      const produced = produce<unknown>(input[key], () => value);
      if (produced !== input[key]) stateDelta[key] = { kind: "value", value: produced };
    } else {
      const delta = diffValue(base[key], value);
      if (delta !== undefined) stateDelta[key] = delta;
    }
  }
  return { ...result, stateDelta };
}
