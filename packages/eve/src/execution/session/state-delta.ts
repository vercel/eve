import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { applyValueDelta, type ValueDelta } from "#shared/value-delta.js";

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

/**
 * Applies a step's delta to the values that step was given. The workflow body runs this; steps
 * produce the delta with `withSessionStateDelta` (`step-state-delta.ts`).
 */
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
