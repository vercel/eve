import type { ModelMessage } from "ai";

import type {
  AssistantStepFinishReason,
  RuntimeIdentity,
  RuntimeTraceContext,
} from "#protocol/message.js";
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

/**
 * Emits `step.started` for one model call.
 */
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
  await emitFn(createSessionWaitingEvent());

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
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCompletedEvent({
      sequence: state.sequence,
      turnId: state.turnId,
    }),
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

/**
 * Maps an AI SDK finish reason string to the eve-owned
 * {@link AssistantStepFinishReason} union. Unknown values become `"other"`.
 */
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
