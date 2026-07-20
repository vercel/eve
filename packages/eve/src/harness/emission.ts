import {
  createMessageReceivedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
} from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { JsonObject } from "#shared/json.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";

// ---------------------------------------------------------------------------
// Emission state
// ---------------------------------------------------------------------------

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
 * Returns `true` when the harness is **between turns** — either no turn
 * has started yet (initial state) or the previous turn has emitted its
 * epilogue (or recoverable failure cascade) and reset.
 *
 * Returns `false` while a turn is in progress, including during
 * tool-loop continuations and runtime-action resumes within the same
 * turn. Callers that gate per-turn work (eg. lifecycle hook dispatch)
 * use this predicate to distinguish a fresh delivery from a
 * continuation of an in-flight turn.
 *
 * Implemented over the empty-`turnId` sentinel that `emitTurnEpilogue`
 * and `emitRecoverableFailedTurn` write — clients should never read
 * `state.turnId` directly to make this distinction.
 */
export function isHarnessBetweenTurns(session: HarnessSession): boolean {
  return getHarnessEmissionState(session.state).turnId === "";
}

/**
 * Writes the emission state onto a new copy of the session.
 */
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

// ---------------------------------------------------------------------------
// Turn lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Emits `session.started` (once), `turn.started`, and `message.received` at the
 * beginning of a new turn. Returns updated emission state.
 */
export async function emitTurnPreamble(
  emitFn: HarnessEmitFn,
  input: StepInput,
  state: HarnessEmissionState,
  runtimeIdentity?: RuntimeIdentity,
): Promise<HarnessEmissionState> {
  const turnId = `turn_${state.sequence}`;

  if (!state.sessionStarted) {
    await emitFn(createSessionStartedEvent({ runtime: runtimeIdentity }));
  }

  await emitFn(createTurnStartedEvent({ sequence: state.sequence, turnId }));

  if (input.message !== undefined) {
    await emitFn(
      createMessageReceivedEvent({
        message: input.message,
        sequence: state.sequence,
        turnId,
      }),
    );
  }

  return {
    sessionStarted: true,
    sequence: state.sequence,
    stepIndex: 0,
    turnId,
  };
}

/**
 * Emits `step.started` for one model call.
 */
export async function emitStepStarted(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  messages?: readonly import("ai").ModelMessage[],
): Promise<void> {
  await emitFn(
    createStepStartedEvent({
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    }),
    messages,
  );
}

interface FailedStepPayload {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}

/**
 * Emits the shared head of both failure cascades: `step.failed` →
 * `turn.failed`. Both terminal and recoverable paths diverge only on
 * the third event (`session.failed` vs. `session.waiting`).
 */
async function emitStepAndTurnFailed(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload,
): Promise<void> {
  await emitFn(
    createStepFailedEvent({
      ...input,
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    }),
  );
  await emitFn(
    createTurnFailedEvent({
      ...input,
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  );
}

/**
 * Emits the full terminal failure cascade: `step.failed` →
 * `turn.failed` → `session.failed`.
 *
 * Use this when the session cannot be salvaged (structural config
 * error, auth misconfig, non-recoverable provider response). The
 * `session.failed` tail tells adapters the session is dead and no
 * further follow-up is possible on the same continuation token.
 */
export async function emitFailedStep(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly sessionId: string },
): Promise<void> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionFailedEvent(input));
}

/**
 * Emits the recoverable failure cascade: `step.failed` →
 * `turn.failed` → `session.waiting`.
 */
export async function emitRecoverableFailedTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly continuationToken: string },
): Promise<HarnessEmissionState> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionWaitingEvent(input.continuationToken));

  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}

/**
 * Returns updated emission state for the next step in the current turn.
 */
export function advanceStep(state: HarnessEmissionState): HarnessEmissionState {
  return {
    ...state,
    stepIndex: state.stepIndex + 1,
  };
}

/**
 * Emits `turn.completed` and either `session.waiting` or `session.completed`.
 * Returns updated emission state with an incremented sequence.
 */
export async function emitTurnEpilogue(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  mode: RunMode,
  continuationToken: string,
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCompletedEvent({
      sequence: state.sequence,
      turnId: state.turnId,
    }),
  );

  if (mode === "conversation") {
    await emitFn(createSessionWaitingEvent(continuationToken));
  } else {
    await emitFn(createSessionCompletedEvent());
  }

  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}

export {
  emitStreamContent,
  normalizeAssistantStepFinishReason,
} from "#harness/stream-content-emission.js";
