import type { DurableSession, DurableSessionState } from "#execution/durable-session-store.js";
import { applyValueDelta, captureValue, createValueDelta, type ValueDelta } from "./state-delta.js";
import type { DurableStepResult, TurnStepState } from "./turn-step-types.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DurableStepDelta = DistributiveOmit<
  DurableStepResult,
  "serializedContext" | "sessionState" | "backgroundTaskContext" | "backgroundTaskState"
> & {
  readonly version: 1;
  readonly sessionId: string;
  readonly delta: ValueDelta;
  readonly backgroundDelta?: ValueDelta;
  readonly hasBackgroundTaskContext?: true;
};

function project(state: TurnStepState) {
  const { snapshot, ...metadata } = state.sessionState;
  return {
    serializedContext: state.serializedContext,
    session: snapshot.session,
    // The projection may alias the emission state inside the session. It is value-only metadata.
    metadata: { ...metadata, emissionState: { ...metadata.emissionState } },
  };
}

export function captureTurnStepState(state: TurnStepState): unknown {
  return captureValue(project(state));
}

export function createTurnStepDelta(before: unknown, result: DurableStepResult): DurableStepDelta {
  const {
    serializedContext,
    sessionState,
    backgroundTaskContext,
    backgroundTaskState,
    ...outcome
  } = result;
  return {
    ...outcome,
    version: 1,
    sessionId: sessionState.sessionId,
    delta: createValueDelta(before, project({ serializedContext, sessionState })),
    ...(backgroundTaskState === undefined
      ? {}
      : {
          ...(backgroundTaskContext === undefined
            ? {}
            : { hasBackgroundTaskContext: true as const }),
          backgroundDelta: createValueDelta(
            before,
            project({
              serializedContext: backgroundTaskContext ?? serializedContext,
              sessionState: backgroundTaskState,
            }),
          ),
        }),
  };
}

/** Both branches are relative to the invocation checkpoint, never to each other. */
export function applyTurnStepDelta(
  before: TurnStepState,
  result: DurableStepDelta,
): DurableStepResult {
  if (result.version !== 1 || result.sessionId !== before.sessionState.sessionId) {
    throw new Error("Unsupported or mismatched turn step delta.");
  }
  const {
    version: _version,
    sessionId: _sessionId,
    delta,
    backgroundDelta,
    hasBackgroundTaskContext,
    ...outcome
  } = result;
  const restore = (patch: ValueDelta): TurnStepState => {
    const next = applyValueDelta(project(before), patch) as {
      serializedContext: Record<string, unknown>;
      session: DurableSession;
      metadata: Omit<DurableSessionState, "snapshot">;
    };
    return {
      serializedContext: next.serializedContext,
      sessionState: { ...next.metadata, snapshot: { session: next.session } },
    };
  };
  const background = backgroundDelta === undefined ? undefined : restore(backgroundDelta);
  return {
    ...outcome,
    ...restore(delta),
    ...(background === undefined
      ? {}
      : {
          ...(hasBackgroundTaskContext
            ? { backgroundTaskContext: background.serializedContext }
            : {}),
          backgroundTaskState: background.sessionState,
        }),
  };
}
