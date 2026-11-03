import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import { signInInteractionId } from "#harness/interaction-facts.js";
import { changeHistory, type HistoryChange } from "./history.js";
import type { HarnessSession, HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { readHitlState, writeHitlState, type HitlStateChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState, type TurnState } from "./state.js";
import type { SessionView } from "./view.js";

// The save side of the machine. A transition returns the events that report what changed and
// the execution state that follows; `applyTransition` publishes the events in order (the publish
// sink folds each into the projection) and writes the rest.
// A private record lives only while the projection shows its owner open, so closing an owner is
// one event: a transition reports it, and the save drops the record here.

/** What a machine transition returns. */
export interface Transition extends HitlStateChange {
  readonly turn: TurnState;
  readonly events: readonly SessionEvent[];
  /** How the transition changes history: messages it commits, or a clear's empty history. */
  readonly history?: HistoryChange;
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
  if (transition.history === undefined) return next;
  if (!("history" in next)) {
    throw new Error("A transition that changes history needs the session's history.");
  }
  return changeHistory(
    next as T & Pick<HarnessSession, "compaction" | "history">,
    transition.history,
  );
}

/** The messages a transition commits to the end of history. */
export function committedMessages(transition: Transition): readonly ModelMessage[] {
  return transition.history !== undefined && "append" in transition.history
    ? transition.history.append
    : [];
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
