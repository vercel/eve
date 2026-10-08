import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import {
  publishSessionEvents,
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionEventOrigin,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { applyTransition, sessionView, type Transition } from "#harness/session-machine/commit.js";
import { storedProjection, type SessionView } from "#harness/session-machine/view.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * The commit path for a step that changes the session outside a turn: restore the session, run
 * one machine transition on it, save what it changed, then publish its events in order. The
 * publication saves after that, folding the events into the projection and dropping the private
 * records whose owner they close.
 */
export async function commitSessionStep(
  target: SessionStepState,
  transition: (view: SessionView) => Transition,
  origin: SessionEventOrigin = "relayed",
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(target.sessionState);
  const view = sessionView(storedProjection(session.state), session.state);
  const events: UnstampedMessageStreamEvent[] = [];
  const applied = await applyTransition(session, transition(view), async (event) => {
    events.push(event);
  });
  const sessionState = replaceDurableSessionSnapshot({
    session: applied,
    state: target.sessionState,
  });
  const publish = origin === "own" ? publishSessionEvents : relaySessionEvents;
  return await publish({ ...target, sessionState }, events);
}
