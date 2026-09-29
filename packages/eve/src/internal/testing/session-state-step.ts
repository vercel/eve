import type { SessionStateTransition, SessionStateValues } from "#execution/session/state-delta.js";
import { applyValueDelta, snapshotValue } from "#shared/value-delta.js";

type SessionValueKey = keyof SessionStateValues;

/** A step result with its state delta applied to the session values its input carried. */
export type AppliedSessionStateStep<I, R> = R extends unknown
  ? Omit<R, "stateDelta"> & Pick<SessionStateValues, Extract<keyof I, SessionValueKey>>
  : never;

/**
 * Calls a session step as the session workflow does. A test hands the step its
 * own objects rather than a deserialized copy, so the values the delta applies
 * to are snapshotted before the step can edit them in place.
 */
export async function runSessionStateStep<
  I extends Partial<SessionStateValues>,
  R extends SessionStateTransition,
>(input: I, step: (input: I) => Promise<R>): Promise<AppliedSessionStateStep<I, R>> {
  const serializedContext = snapshotValue(input.serializedContext);
  const sessionState = snapshotValue(input.sessionState);
  const { stateDelta, ...result } = await step(input);
  const applied: Partial<SessionStateValues> = {
    ...(serializedContext !== undefined && {
      serializedContext: applyValueDelta(serializedContext, stateDelta.serializedContext),
    }),
    ...(sessionState !== undefined && {
      sessionState: applyValueDelta(sessionState, stateDelta.sessionState),
    }),
  };
  return { ...result, ...applied } as AppliedSessionStateStep<I, R>;
}
