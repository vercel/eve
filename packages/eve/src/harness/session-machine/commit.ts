import type { SessionEvent } from "#protocol/session-event.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { ModelMessage } from "ai";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { readHitlState, writeHitlState, type RelayChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState, type TurnState } from "./state.js";
import type { SessionView } from "./view.js";

// The save side of the machine. A transition returns the events that report what changed and
// the execution state that follows; `applyTransition` publishes the events in order (the publish
// sink folds each into the projection) and writes the rest. The turn state also has direct lifecycle helpers.
// A private record lives only while the projection shows its owner open, so closing an owner is
// one event: a transition reports it, and the save drops the record here.

/** What a machine transition returns; approval storage still has direct writers. */
export interface Transition {
  readonly turn: TurnState;
  readonly events: readonly SessionEvent[];
  /** Messages the transition commits to the end of history. */
  readonly commit?: readonly ModelMessage[];
  /** The transition empties history, as `clear` does. */
  readonly clearsHistory?: true;
  /** Every sign-in the session waits on once the transition applies; `[]` withdraws them all. */
  readonly signIns?: readonly AuthorizationChallenge[];
  /** Relay routes the transition records or retires. */
  readonly relays?: RelayChange;
}

/**
 * Publishes one event, or one transition's events as one commit; `messages` is the conversation
 * the participants of the events that read history see.
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
    signIns: hitl.signIns,
    turn: readTurnState(state),
    usage: getSessionUsage({ state }),
  };
}

/**
 * The facts participants read the conversation at: a turn's start and end, and each model run's
 * request. The session starts before any history, so `session.started` never carries it.
 */
const READS_HISTORY: ReadonlySet<string> = new Set([
  "turn.started",
  "model.requested",
  "turn.settled",
]);

/** True for an event whose participants read the conversation. */
export function readsHistory(type: string): boolean {
  return READS_HISTORY.has(type);
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
  await publishTransition(transition, publish, messages);
  return saveTransition(session, transition);
}

/** Publishes a transition's events as one commit. */
export async function publishTransition(
  transition: Transition,
  publish: Publish,
  messages?: readonly ModelMessage[],
): Promise<void> {
  if (transition.events.length > 0) await publish(transition.events, messages);
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

/** Drops the private records whose owner the projection shows closed. */
export function dropClosedRecords<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  const closed = [...readHitlState(session.state).relays.keys()].filter((requestId) => {
    const row = projection.view?.interactions[requestId];
    return row === undefined || row.status === "settled";
  });
  return writeHitlState(session, { relays: { retire: closed } });
}
