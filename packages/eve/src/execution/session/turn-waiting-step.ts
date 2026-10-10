import { readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { hold } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";

/** Publishes `turn.paused` for the open turn the session workflow just parked. */
export async function publishTurnWaitingStep(
  target: SessionStepState,
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(target, async (input) => {
    const session = readDurableSession(input.sessionState);
    const view = sessionView(storedProjection(session.state), session.state);
    const { events } = hold(view, { on: "tasks" });
    if (events.length === 0)
      return { serializedContext: input.serializedContext, sessionState: input.sessionState };
    return await publishSessionEvents(input, events);
  });
}
