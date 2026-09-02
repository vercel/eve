import type { ModelMessage } from "ai";

import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessEmitFn, StepInput } from "#harness/types.js";
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
  type AssistantStepFinishReason,
  type RuntimeIdentity,
  type RuntimeTraceContext,
} from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";

/** Emits the session/turn/message preamble and advances to the active turn state. */
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
      createMessageReceivedEvent({ message: input.message, sequence: state.sequence, turnId }),
    );
  }
  return { sessionStarted: true, sequence: state.sequence, stepIndex: 0, turnId };
}

/** Emits `step.started` for one model call. */
export async function emitStepStarted(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  modelId: string,
  messages?: readonly ModelMessage[],
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
  await emitFn(createTurnFailedEvent({ ...input, sequence: state.sequence, turnId: state.turnId }));
}

/** Emits the full terminal step, turn, and session failure cascade. */
export async function emitFailedStep(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  input: FailedStepPayload & { readonly sessionId: string },
): Promise<void> {
  await emitStepAndTurnFailed(emitFn, state, input);
  await emitFn(createSessionFailedEvent(input));
}

/** Emits a recoverable step and turn failure, then parks the session. */
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

/** Advances to the next model step in the current turn. */
export function advanceStep(state: HarnessEmissionState): HarnessEmissionState {
  return { ...state, stepIndex: state.stepIndex + 1 };
}

/** Emits turn completion and either parks or completes the session. */
export async function emitTurnEpilogue(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  mode: RunMode,
): Promise<HarnessEmissionState> {
  await emitFn(createTurnCompletedEvent({ sequence: state.sequence, turnId: state.turnId }));
  await emitFn(
    mode === "conversation" ? createSessionWaitingEvent() : createSessionCompletedEvent(),
  );
  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}

/** Maps an AI SDK finish reason onto eve's stable finish-reason union. */
export function normalizeAssistantStepFinishReason(
  value: string | undefined,
): AssistantStepFinishReason {
  switch (value) {
    case "content-filter":
    case "error":
    case "length":
    case "stop":
    case "tool-calls":
      return value;
    default:
      return "other";
  }
}
