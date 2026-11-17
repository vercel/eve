import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import { signInInteractionId } from "#harness/interaction-facts.js";
import { changeHistory, type HistoryChange } from "./history.js";
import type {
  Commit,
  HarnessSession,
  HarnessSessionBase,
  SessionPublication,
  SessionStateMap,
} from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { readHitlState, writeHitlState, type HitlStateChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState, type TurnState } from "./state.js";
import type { SessionView } from "./view.js";

declare const transitionBrand: unique symbol;

export interface Transition extends HitlStateChange {
  readonly [transitionBrand]: true;
  readonly turn: TurnState;
  readonly events: readonly SessionEvent[];
  readonly history?: HistoryChange;
}

export function transition<T extends Omit<Transition, typeof transitionBrand>>(
  change: T,
): T & Transition {
  return change as T & Transition;
}

export function unchangedBy(commit: Commit, turn: TurnState): Transition {
  return transition({ events: commit, turn });
}

export type Publish = (
  publication: SessionPublication,
  messages?: readonly ModelMessage[],
) => Promise<void>;

export function commitOf(facts: readonly SessionEvent[]): Commit {
  return facts as Commit;
}

export function commitTransitions(transitions: readonly Transition[]): Commit {
  return commitOf(transitions.flatMap((transition) => transition.events));
}

export function joinCommits(publications: readonly SessionPublication[]): SessionPublication[] {
  const joined: SessionPublication[] = [];
  for (const publication of publications) {
    const last = joined.at(-1);
    if (Array.isArray(publication) && Array.isArray(last)) {
      joined[joined.length - 1] = commitOf([...last, ...publication]);
    } else if (!Array.isArray(publication) || publication.length > 0) {
      joined.push(publication);
    }
  }
  return joined;
}

export function sessionView(
  projection: SessionProjection,
  state: SessionStateMap | undefined,
): SessionView {
  const hitl = readHitlState(state);
  return {
    projection,
    relayedRequestIds: new Set(hitl.relays.keys()),
    responders: hitl.responders,
    signIns: hitl.signIns.filter(
      (challenge) =>
        projection.view.interactions[signInInteractionId(challenge)]?.status !== "settled",
    ),
    turn: readTurnState(state),
  };
}

export async function applyTransition<T extends { readonly state?: SessionStateMap }>(
  session: T,
  transition: Transition,
  publish: Publish,
  messages?: readonly ModelMessage[],
): Promise<T> {
  if (transition.events.length > 0) await publish(commitOf(transition.events), messages);
  return saveTransition(session, transition);
}

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

export function committedMessages(transition: Transition): readonly ModelMessage[] {
  return transition.history !== undefined && "append" in transition.history
    ? transition.history.append
    : [];
}

export function dropClosedRecords<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  return writeHitlState(session, {}, projection.view);
}
