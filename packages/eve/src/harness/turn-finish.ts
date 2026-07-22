import type { ModelMessage } from "ai";
import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  classifyParkedSession,
  extractFinalOutput,
  OUTPUT_SCHEMA_NOT_FULFILLED,
  persistStructuredAssistantTurn,
} from "#harness/step-result.js";
import type { GenerateOutcome, HarnessSession, GenerateConfig } from "#harness/types.js";
import { createResultCompletedEvent } from "#protocol/message.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";

/** Emits `result.completed` followed by the turn epilogue for `mode`. */
async function emitStructuredResult(
  emit: NonNullable<GenerateConfig["handleEvent"]>,
  emissionState: ReturnType<typeof getHarnessEmissionState>,
  structured: JsonValue,
  mode: RunMode,
  continuationToken: string,
): Promise<ReturnType<typeof getHarnessEmissionState>> {
  await emit(
    createResultCompletedEvent({
      result: structured,
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    }),
  );
  return emitTurnEpilogue(emit, emissionState, mode, continuationToken);
}

/**
 * Closes a terminal task turn. Task runs cannot park, so an unmet output
 * schema fails as an error a delegating parent can surface; otherwise the
 * structured value — or the plain assistant text — is the run's output.
 */
export async function finishTaskTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
  readonly stepOutput: string | null;
}): Promise<GenerateOutcome> {
  const { emit, history, result, schema, stepOutput } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(
        emit,
        emissionState,
        "task",
        session.continuationToken,
      );
      session = setHarnessEmissionState(session, emissionState);
    }
    return { action: "done", output: stepOutput ?? "", state: session };
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      await emitFailedStep(emit, emissionState, {
        ...OUTPUT_SCHEMA_NOT_FULFILLED,
        sessionId: session.sessionId,
      });
    }
    return {
      action: "done",
      isError: true,
      output: OUTPUT_SCHEMA_NOT_FULFILLED.message,
      state: session,
    };
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(
      emit,
      emissionState,
      structured,
      "task",
      session.continuationToken,
    );
    session = setHarnessEmissionState(session, emissionState);
  }
  return { action: "done", output: structured, state: session };
}

/**
 * Closes a terminal conversation turn. Conversation runs may park, so an unmet
 * output schema parks recoverably; otherwise the structured value (or prose)
 * ends the turn and the session waits for the next message.
 */
export async function finishConversationTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
}): Promise<GenerateOutcome> {
  const { emit, history, result, schema } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(
        emit,
        emissionState,
        "conversation",
        session.continuationToken,
      );
      session = setHarnessEmissionState(session, emissionState);
    }
    return classifyParkedSession(session);
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
        ...OUTPUT_SCHEMA_NOT_FULFILLED,
        continuationToken: session.continuationToken,
      });
      session = setHarnessEmissionState(session, emissionState);
    }
    return classifyParkedSession(session);
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(
      emit,
      emissionState,
      structured,
      "conversation",
      session.continuationToken,
    );
    session = setHarnessEmissionState(session, emissionState);
  }
  return classifyParkedSession(session);
}
