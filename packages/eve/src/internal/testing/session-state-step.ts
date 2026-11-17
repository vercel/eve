import type { SessionStateTransition, SessionStateValues } from "#execution/session/state-delta.js";
import { applyValueDelta, snapshotValue } from "#shared/value-delta.js";

type SessionValueKey = keyof SessionStateValues;

export type AppliedSessionStateStep<I, R> = R extends unknown
  ? Omit<R, "stateDelta"> & Pick<SessionStateValues, Extract<keyof I, SessionValueKey>>
  : never;

export async function runSessionStateStep<
  I extends Partial<SessionStateValues>,
  R extends SessionStateTransition,
>(input: I, step: (input: I) => Promise<R>): Promise<AppliedSessionStateStep<I, R>> {
  const serializedContext = snapshotValue(input.serializedContext);
  const sessionState = snapshotValue(input.sessionState);
  const history = snapshotValue(input.history);
  const { stateDelta, ...result } = await step(input);
  const applied: Partial<SessionStateValues> = {
    ...(serializedContext !== undefined && {
      serializedContext: applyValueDelta(serializedContext, stateDelta.serializedContext),
    }),
    ...(sessionState !== undefined && {
      sessionState: applyValueDelta(sessionState, stateDelta.sessionState),
    }),
    ...(history !== undefined && { history: applyValueDelta(history, stateDelta.history) }),
  };
  return { ...result, ...applied } as AppliedSessionStateStep<I, R>;
}
