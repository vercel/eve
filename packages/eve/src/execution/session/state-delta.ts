import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { applyValueDelta, type ValueDelta } from "#shared/value-delta.js";

export interface SessionStateValues {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
}

export interface SessionStateDelta {
  readonly serializedContext?: ValueDelta;
  readonly sessionState?: ValueDelta;
  readonly history?: ValueDelta;
}

export interface SessionStateTransition {
  readonly stateDelta: SessionStateDelta;
}

export type WithSessionStateDelta<T> = T extends unknown
  ? Omit<T, keyof SessionStateValues> & SessionStateTransition
  : never;

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
