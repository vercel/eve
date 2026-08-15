import type { HarnessSession, SessionStateMap } from "#harness/types.js";

/**
 * Tracks emission lifecycle state across harness step invocations.
 *
 * Persisted on `session.state` so the state survives when the durable
 * workflow runtime recreates the harness at each `"use step"` boundary.
 */
export interface HarnessEmissionState {
  readonly sessionStarted: boolean;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

const HARNESS_EMISSION_STATE_KEY = "eve.harness.emission";

const DEFAULT_EMISSION_STATE: HarnessEmissionState = {
  sessionStarted: false,
  sequence: 0,
  stepIndex: 0,
  turnId: "",
};

/** Reads the emission state, returning defaults when absent. */
export function getHarnessEmissionState(state: SessionStateMap | undefined): HarnessEmissionState {
  const emissionState = state?.[HARNESS_EMISSION_STATE_KEY] as HarnessEmissionState | undefined;
  return emissionState ?? DEFAULT_EMISSION_STATE;
}

/**
 * Returns `true` when the harness is between turns — either no turn has
 * started yet or the previous turn has emitted its epilogue and reset.
 *
 * The empty `turnId` sentinel distinguishes a fresh delivery from an in-flight
 * continuation. Callers should use this predicate instead of reading it.
 */
export function isHarnessBetweenTurns(session: HarnessSession): boolean {
  return getHarnessEmissionState(session.state).turnId === "";
}

/** Writes the emission state onto a new copy of the session. */
export function setHarnessEmissionState(
  session: HarnessSession,
  state: HarnessEmissionState,
): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [HARNESS_EMISSION_STATE_KEY]: state,
    },
  };
}
