import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { applyValueDelta, diffValue, snapshotValue, type ValueDelta } from "#shared/value-delta.js";

/**
 * The durable values a session workflow threads through its steps. `history`
 * is separate from `sessionState` so that only the steps that read or change
 * it receive it as input.
 */
export interface SessionStateValues {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

/** How a step changed the session's values; an absent value is unchanged. */
export interface SessionStateDelta {
  readonly serializedContext?: ValueDelta;
  readonly sessionState?: ValueDelta;
  readonly history?: ValueDelta;
}

/** A step result the session workflow adopts through its state cursor. */
export interface SessionStateTransition {
  readonly stateDelta: SessionStateDelta;
}

/** `T` with its session values replaced by the delta that produces them. */
export type WithSessionStateDelta<T> = T extends unknown
  ? Omit<T, keyof SessionStateValues> & SessionStateTransition
  : never;

const SESSION_VALUE_KEYS = ["serializedContext", "sessionState", "history"] as const;

/**
 * Runs a session step's work and returns its result with the session values
 * it produced replaced by their delta from the values the step was given.
 *
 * Workflow replay reads every step's output but no step's input, so a step
 * that returns only what changed keeps both replay and storage from carrying
 * the whole session once per step. The workflow body applies the delta to the
 * values it passed in; see {@link applySessionStateDelta}.
 *
 * The input is snapshotted before `work` runs because step code may edit it
 * in place, as a channel adapter does with its state.
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
  const { serializedContext, sessionState, history, ...result } = await work(input);
  const next = { serializedContext, sessionState, history };
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  for (const key of SESSION_VALUE_KEYS) {
    const delta = next[key] === undefined ? undefined : diffValue(base[key], next[key]);
    if (delta !== undefined) stateDelta[key] = delta;
  }
  return { ...result, stateDelta };
}

/** Applies a step's delta to the values that step was given. */
export function applySessionStateDelta(
  values: SessionStateValues,
  delta: SessionStateDelta,
): SessionStateValues {
  return {
    serializedContext: applyValueDelta(values.serializedContext, delta.serializedContext),
    sessionState: applyValueDelta(values.sessionState, delta.sessionState),
    history: applyValueDelta(values.history, delta.history),
  };
}
