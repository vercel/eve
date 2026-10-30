import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import { signInInteractionId } from "#harness/interaction-facts.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { readHitlState, writeHitlState, type HitlStateChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState, type TurnState } from "./state.js";
import type { SessionView } from "./view.js";

// The save side of the machine. A transition returns the events that report what changed and
// the execution state that follows; `applyTransition` publishes the events in order (the publish
// sink folds each into the projection) and writes the rest. The turn state also has direct lifecycle helpers.
// A private record lives only while the projection shows its owner open, so closing an owner is
// one event: a transition reports it, and the save drops the record here.

/** What a machine transition returns; approval storage still has direct writers. */
export interface Transition extends HitlStateChange {
  readonly turn: TurnState;
  readonly events: readonly SessionEvent[];
  /** Messages the transition commits to the end of history. */
  readonly commit?: readonly ModelMessage[];
  /** The transition empties history, as `clear` does. */
  readonly clearsHistory?: true;
}

/**
 * Publishes one event, or one transition's events as one commit; `messages` is the conversation as
 * of the commit, for the reactions that read it.
 */
export type Publish = (
  publication: SessionEvent | readonly SessionEvent[],
  messages?: readonly ModelMessage[],
) => Promise<void>;

export function sessionView(
  projection: SessionProjection,
  state: SessionStateMap | undefined,
): SessionView {
  const hitl = readHitlState(state);
  return {
    projection,
    relayedRequestIds: new Set(hitl.relays.keys()),
    responders: hitl.responders,
    // A sign-in whose interaction closed, as when its call settles without it, is no longer one
    // the session waits on.
    signIns: hitl.signIns.filter(
      (challenge) =>
        projection.view.interactions[signInInteractionId(challenge)]?.status !== "settled",
    ),
    turn: readTurnState(state),
  };
}

/**
 * Publishes a transition's events as one commit, then saves what it changed. A transition that
 * changes history needs a session restored with it.
 */
export async function applyTransition<T extends { readonly state?: SessionStateMap }>(
  session: T,
  transition: Transition,
  publish: Publish,
  messages?: readonly ModelMessage[],
): Promise<T> {
  if (transition.events.length > 0) await publish(transition.events, messages);
  return saveTransition(session, transition);
}

/** Saves what a transition changes once its events are published. */
export function saveTransition<T extends { readonly state?: SessionStateMap }>(
  session: T,
  transition: Transition,
): T {
  const next = writeTurnState(writeHitlState(session, transition), transition.turn);
  const commit = transition.commit ?? [];
  if (transition.clearsHistory !== true && commit.length === 0) return next;
  if (!("history" in session)) {
    throw new Error("A transition that changes history needs the session's history.");
  }
  const { history: previous } = session as T & Pick<HarnessSession, "history">;
  const history = transition.clearsHistory
    ? []
    : validateHarnessModelMessages([...previous, ...commit]);
  return { ...next, history };
}

/**
 * Drops the private records whose row the projection shows done, the one way they retire: a
 * relay's route once its asker settles the interaction, and a responder's once their answer
 * settled. Admitted answers can still be refused while the rest of their batch waits.
 */
export function dropClosedRecords<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  return writeHitlState(session, {}, projection.view);
}
