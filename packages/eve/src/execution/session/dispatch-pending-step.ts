import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";

/**
 * Runs the session's pending dispatches with no work of its own, for a
 * workflow body that is about to wait, hand off, or end.
 */
export async function dispatchPendingSessionEventsStep(
  input: SessionStepState,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, async ({ serializedContext, sessionState }) => ({
    serializedContext,
    sessionState,
  }));
}
