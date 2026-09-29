import {
  publishSessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { createTurnWaitingEvent } from "#protocol/message.js";

/** Publishes `turn.waiting` for the open turn the session workflow just parked. */
export async function publishTurnWaitingStep(
  target: SessionStepState,
): Promise<PublishedSessionEvents> {
  "use step";

  const { sequence, turnId } = target.sessionState.emissionState;
  return await publishSessionEvents(target, [createTurnWaitingEvent({ sequence, turnId })]);
}
