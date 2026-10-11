import { isDynamicConnectionResolutionError } from "#context/dynamic-connection-lifecycle.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { fail } from "#harness/session-machine/transitions.js";
import { activeTurnId, turnPosition } from "#harness/session-machine/view.js";
import type { HandleEventFn, HarnessSession, StepResult } from "#harness/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("turn-step");

/**
 * Parks the session with `step.failed` → `turn.failed` → `session.waiting`
 * when a dynamic connection resolver throws during rehydration, so the next
 * message can retry once the dependency recovers. Returns `undefined` for any
 * other error so the caller rethrows it.
 */
export async function recoverDynamicConnectionRehydration(input: {
  readonly error: unknown;
  readonly emit: HandleEventFn;
  readonly projection: SessionProjection;
  readonly session: HarnessSession;
}): Promise<StepResult | undefined> {
  if (!isDynamicConnectionResolutionError(input.error)) {
    return undefined;
  }

  const errorId = createErrorId();
  const message = toErrorMessage(input.error);
  log.error("dynamic connection rehydration failed — parking session", {
    error: input.error,
    errorId,
    sessionId: input.session.sessionId,
    turnId: activeTurnId(turnPosition(input.projection)),
  });
  const session = await applyTransition(
    input.session,
    fail(sessionView(input.projection, input.session.state), {
      code: "EVENT_HANDLER_FAILED",
      details: { errorId },
      message,
    }),
    input.emit,
  );
  return {
    next: null,
    session: { ...session, outputSchema: undefined },
    settledTurn: { isError: true, output: message },
  };
}
