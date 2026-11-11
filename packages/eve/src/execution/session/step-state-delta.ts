import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { followInterruptedAttempt, readOrphanedLines } from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { freeze, isDraftable, produce } from "#compiled/immer/index.js";
import { applyValueDelta, diffValue, snapshotValue, type ValueDelta } from "#shared/value-delta.js";

// Steps only: the workflow body applies what this returns with `applySessionStateDelta`, and
// can't import the session's publication.

const SESSION_VALUE_KEYS = ["serializedContext", "sessionState", "history"] as const;

/**
 * Whether Workflow stores frozen step values by reference. Its QuickJS
 * workflow VM can't read references yet, so values are stored in full there.
 */
function storedByReference(): boolean {
  return process.env.WORKFLOW_VM !== "quickjs";
}

/**
 * The next version of a session value: `delta` applied to the value the step
 * was given, through an immer draft. Unchanged entries stay the objects the
 * given value holds and the result is deeply frozen, so Workflow stores it as
 * only its change from the given value.
 */
function nextVersion(given: unknown, delta: ValueDelta): unknown {
  if (delta.kind === "value" || !isDraftable(given)) {
    return freeze(applyValueDelta(given, delta), true);
  }
  return produce(given, (draft) => applyToDraft(draft, delta));
}

/** `applyValueDelta` on a draft: the same entries, in the same order. */
function applyToDraft(draft: any, delta: ValueDelta): void {
  if (delta.kind === "value") throw new Error("A whole value replaces the draft.");
  const apply = (key: string | number, change: ValueDelta) => {
    if (change.kind === "value") draft[key] = change.value;
    else applyToDraft(draft[key], change);
  };
  if (delta.kind === "array") {
    if (draft.length > delta.length) draft.length = delta.length;
    for (const [index, value] of Object.entries(delta.set ?? {})) draft[Number(index)] = value;
    for (const [index, change] of Object.entries(delta.patch ?? {})) apply(Number(index), change);
    return;
  }
  const keys = delta.keys;
  if (keys !== undefined) {
    const kept = new Set(keys);
    for (const key of Object.keys(draft)) if (!kept.has(key)) delete draft[key];
  }
  for (const [key, value] of Object.entries(delta.set ?? {})) draft[key] = value;
  for (const [key, change] of Object.entries(delta.patch ?? {})) apply(key, change);
  // Re-adding each key in turn leaves them in the delta's order.
  if (keys !== undefined && !sameOrder(Object.keys(draft), keys)) {
    for (const key of keys) {
      const value = draft[key];
      delete draft[key];
      draft[key] = value;
    }
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * Runs a session step's work and returns its result with the session values
 * it produced replaced by their delta from the values the step was given.
 *
 * Workflow replay reads every step's output but no step's input, so a step
 * that returns only what changed keeps both replay and storage from carrying
 * the whole session once per step. The workflow body applies the delta to the
 * values it passed in; see `applySessionStateDelta`.
 *
 * Where Workflow stores frozen values by reference, each changed value is
 * instead returned whole, as the next immer version of the value the step was
 * given (see `nextVersion`): Workflow stores this output as only its change,
 * the next step's input as a reference, and the workflow body adopts the value
 * as given. Values Workflow rebuilt from references arrive frozen, so step
 * code gets editable copies of them.
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
  const editable = <T>(value: T): T =>
    value !== null && typeof value === "object" && Object.isFrozen(value)
      ? snapshotValue(value)
      : value;
  const given = { ...input };
  if ("serializedContext" in input) given.serializedContext = editable(input.serializedContext);
  if ("sessionState" in input) given.sessionState = editable(input.sessionState);
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
  const byReference = storedByReference();
  for (const key of SESSION_VALUE_KEYS) {
    const delta = next[key] === undefined ? undefined : diffValue(base[key], next[key]);
    if (delta === undefined) continue;
    stateDelta[key] = byReference
      ? { kind: "value", value: nextVersion(input[key], delta) }
      : delta;
  }
  return { ...result, stateDelta };
}
