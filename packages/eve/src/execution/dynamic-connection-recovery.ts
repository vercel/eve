import { isDynamicConnectionResolutionError } from "#context/dynamic-connection-lifecycle.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import {
  emitRecoverableFailedTurn,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HandleEventFn, HarnessSession, StepResult } from "#harness/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import type { RunMode } from "#shared/run-mode.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("workflow-steps");

export async function recoverDynamicConnectionRehydration(input: {
  readonly error: unknown;
  readonly emit: HandleEventFn;
  readonly mode: RunMode;
  readonly session: HarnessSession;
}): Promise<StepResult | undefined> {
  if (input.mode !== "conversation" || !isDynamicConnectionResolutionError(input.error)) {
    return undefined;
  }

  const failureState = getHarnessEmissionState(input.session.state);
  const errorId = createErrorId();
  const message = toErrorMessage(input.error);
  const turnId = activeTurnId(failureState);
  log.error("dynamic connection rehydration failed — parking session", {
    error: input.error,
    errorId,
    sessionId: input.session.sessionId,
    turnId,
  });
  const emissionState = await emitRecoverableFailedTurn(
    input.emit,
    { ...failureState, turnId },
    {
      code: "EVENT_HANDLER_FAILED",
      continuationToken: input.session.continuationToken,
      details: { errorId },
      message,
    },
  );
  return {
    next: null,
    session: setHarnessEmissionState({ ...input.session, outputSchema: undefined }, emissionState),
    settledTurn: { isError: true, output: message },
  };
}
