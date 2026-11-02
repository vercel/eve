import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { followInterruptedAttempt, readOrphanedLines } from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import type { TurnStepPayload } from "#execution/session/turn-step-types.js";
import { randomUUID } from "node:crypto";
import { SharedHistory } from "#compiled/@workflow/core/index.js";
import { diffValue, snapshotValue, type ValueDelta } from "#shared/value-delta.js";
import type { HarnessModelMessage } from "#harness/messages.js";

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
  // A shared-history prefix is frozen, so it is its own snapshot and keeps its cursor.
  const historyCursor = SharedHistory.cursor(input.history);
  // Read before snapshotting: the copies do not carry the version marks.
  const stateCursors = {
    serializedContext: SharedHistory.stateCursor(input.serializedContext),
    sessionState: SharedHistory.stateCursor(input.sessionState),
  };
  const base = Object.fromEntries(
    SESSION_VALUE_KEYS.map((key) => [
      key,
      key === "history" && historyCursor !== undefined ? input[key] : snapshotValue(input[key]),
    ]),
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
  if (historyCursor !== undefined && stateDelta.history !== undefined && history !== undefined) {
    markSharedHistoryAppend(input, historyCursor, stateDelta.history, history);
  }
  for (const key of ["serializedContext", "sessionState"] as const) {
    const cursor = stateCursors[key];
    if (cursor === undefined) continue;
    // The first step after the session's values were created roots the chain
    // with the whole value, so later inputs refer to step outputs only.
    if (cursor.version === null) {
      stateDelta[key] = { kind: "value", value: next[key] ?? base[key] };
    }
    const delta = stateDelta[key];
    if (delta === undefined) continue;
    SharedHistory.stateDelta(delta, {
      logId: cursor.logId,
      base: cursor.version,
      version: randomUUID(),
    });
  }
  return { ...result, stateDelta };
}

/**
 * Validates that a step only appended to its shared-history prefix and marks the delta as that
 * appended range, projecting new user messages back to the delivery payload that owns their body.
 */
function markSharedHistoryAppend(
  input: Partial<SessionStateValues>,
  historyCursor: { readonly logId: string; readonly end: number },
  delta: ValueDelta,
  history: HarnessModelMessage[],
): void {
  if (delta.kind === "array") {
    if (
      delta.patch !== undefined ||
      Object.keys(delta.set ?? {}).some((key) => Number(key) < historyCursor.end)
    ) {
      throw new Error("Shared history currently requires append-only model messages.");
    }
  } else if (!(delta.kind === "value" && historyCursor.end === 0 && Array.isArray(delta.value))) {
    throw new Error("Shared history currently requires append-only model messages.");
  }
  // Channel payloads are the authoritative user producer. The adapter may
  // normalize the outer message while referring to its already stored body.
  const turn = input as { input?: TurnStepPayload };
  for (let i = historyCursor.end; i < history.length; i++) {
    const message = history[i];
    if (message?.role !== "user" || message.kind !== "user") continue;
    for (const payload of turn.input?.delivery?.payloads ?? []) {
      const origin = SharedHistory.origin(payload, "message");
      if (origin !== undefined && payload.message === message.content) {
        SharedHistory.project(message, { content: origin });
        // diffValue snapshots new values by reference; project the delta's
        // actual entry as well when a normalization made another object.
        const stored =
          delta.kind === "value" ? (delta.value as typeof history)[i] : delta.set?.[String(i)];
        if (stored !== null && typeof stored === "object")
          SharedHistory.project(stored, { content: origin });
        break;
      }
    }
  }
  SharedHistory.append(delta, historyCursor, history.length);
}
