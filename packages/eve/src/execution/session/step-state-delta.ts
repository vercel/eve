import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { followInterruptedAttempt, readOrphanedLines } from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { produce, StateRefs } from "#compiled/@workflow/core/state.js";
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
  if (StateRefs.enabled()) return await withProducedSessionState(input, work);
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

/**
 * `WORKFLOW_STATE_REFS` mode: each changed session value is returned whole, as
 * a `produce()` result of the value the step was given. Workflow then stores the
 * next step's input as a reference and this output as only the change, and the
 * workflow body's `applySessionStateDelta` adopts the value as given.
 *
 * Step code still edits working copies of the context and session state in
 * place; their differences are written into the draft, so every unchanged part
 * stays shared with the stored version. The history is used as given: it is
 * frozen, and steps only append to it.
 */
async function withProducedSessionState(
  input: Partial<SessionStateValues>,
  work: (input: Partial<SessionStateValues>) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const working: Partial<SessionStateValues> = {
    ...input,
    ...(input.serializedContext === undefined
      ? {}
      : { serializedContext: snapshotValue(input.serializedContext) }),
    ...(input.sessionState === undefined
      ? {}
      : { sessionState: snapshotValue(input.sessionState) }),
  };
  const { sessionWritable } = input as { readonly sessionWritable?: WritableStream<Uint8Array> };
  if (sessionWritable !== undefined && working.sessionState !== undefined) {
    const checkpoint = working.sessionState as DurableSessionState;
    const session = readDurableSession(checkpoint);
    await readOrphanedLines({
      sessionId: checkpoint.sessionId,
      position: storedProjection(session.state).view.position,
      sessionWritable,
    });
  }
  const { serializedContext, sessionState, history, ...result } = await work(working);
  const candidateState = sessionState ?? working.sessionState;
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
    const base = input[key];
    if (value === undefined) continue;
    const produced =
      base !== null && typeof base === "object" && canReconcile(base, value)
        ? produce(base as object, (draft) => reconcileInto(draft, base, value))
        : value;
    if (produced !== base) stateDelta[key] = { kind: "value", value: produced };
  }
  return { ...result, stateDelta };
}

function isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a);
    return (
      Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    );
  }
  return false;
}

function grewAtEnd(base: readonly unknown[], next: readonly unknown[]): boolean {
  return next.length >= base.length && base.every((v, i) => sameValue(v, next[i]));
}

function canReconcile(base: unknown, next: unknown): boolean {
  if (Array.isArray(base) && Array.isArray(next))
    return grewAtEnd(base, next) || base.length === next.length;
  return (
    isDict(base) && isDict(next) && Object.getPrototypeOf(base) === Object.getPrototypeOf(next)
  );
}

/** Writes only what differs between `base` and `next` into `draft`, a draft of `base`. */
function reconcileInto(draft: any, base: any, next: any): void {
  if (Array.isArray(base)) {
    if (grewAtEnd(base, next)) {
      for (let i = base.length; i < next.length; i++) draft.push(next[i]);
      return;
    }
    for (let i = 0; i < next.length; i++) {
      if (sameValue(base[i], next[i])) continue;
      if (canReconcile(base[i], next[i])) reconcileInto(draft[i], base[i], next[i]);
      else draft[i] = next[i];
    }
    return;
  }
  for (const key of Object.keys(base)) if (!Object.hasOwn(next, key)) delete draft[key];
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(base, key)) draft[key] = next[key];
    else if (sameValue(base[key], next[key])) continue;
    else if (canReconcile(base[key], next[key])) reconcileInto(draft[key], base[key], next[key]);
    else draft[key] = next[key];
  }
}
