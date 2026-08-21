import type { RuntimeIdentity, RuntimeTraceContext } from "#protocol/message.js";
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
} from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { JsonObject } from "#shared/json.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessEmitFn, StepInput } from "#harness/types.js";

export {
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission-state.js";
export type { HarnessEmissionState } from "#harness/emission-state.js";
export {
  emitStreamContent,
  normalizeAssistantStepFinishReason,
} from "#harness/stream-content-emission.js";

/**
 * Emits `session.started` (once), `turn.started`, and `message.received` at the
 * beginning of a new turn. Returns updated emission state.
 */
export async function emitTurnPreamble(
  emitFn: HarnessEmitFn,
  input: StepInput,
  state: HarnessEmissionState,
  runtimeIdentity?: RuntimeIdentity,
  traceContext?: RuntimeTraceContext,
): Promise<HarnessEmissionState> {
  const turnId = `turn_${state.sequence}`;

  if (!state.sessionStarted) {
    await emitFn(createSessionStartedEvent({ runtime: runtimeIdentity, trace: traceContext }));
  }

  await emitFn(createTurnStartedEvent({ sequence: state.sequence, trace: traceContext, turnId }));

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

/** Emits `step.started` for one model call. */
export async function emitStepStarted(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  modelId: string,
  messages?: readonly import("ai").ModelMessage[],
): Promise<void> {
  await emitFn(
    createStepStartedEvent({
      modelId,
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

/** Emits the shared `step.failed` → `turn.failed` failure prefix. */
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

/** Emits the terminal `step.failed` → `turn.failed` → `session.failed` cascade. */
export async function emitFailedStep(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly sessionId: string },
): Promise<void> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionFailedEvent(input));
}

/** Emits the recoverable `step.failed` → `turn.failed` → `session.waiting` cascade. */
export async function emitRecoverableFailedTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly continuationToken: string },
): Promise<HarnessEmissionState> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionWaitingEvent());

  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}

/** Returns updated emission state for the next step in the current turn. */
export function advanceStep(state: HarnessEmissionState): HarnessEmissionState {
  return {
    ...state,
    stepIndex: state.stepIndex + 1,
  };
}

/** Emits the turn terminal events and advances emission state to the next turn. */
export async function emitTurnEpilogue(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  mode: RunMode,
  messages?: readonly import("ai").ModelMessage[],
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCompletedEvent({
      sequence: state.sequence,
      turnId: state.turnId,
    }),
    messages,
  );

  if (mode === "conversation") {
    await emitFn(createSessionWaitingEvent());
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
