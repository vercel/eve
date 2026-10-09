import { readDurableSession } from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionEventOrigin,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  publishTransition,
  saveTransition,
  sessionView,
  type Transition,
} from "#harness/session-machine/commit.js";
import { storedProjection, type SessionView } from "#harness/session-machine/view.js";

/**
 * The commit of a step that owns the session outside a turn: restore it, decide its transitions
 * against what it restored, publish their events in order, and save what they change. A step
 * changes the session's human-in-the-loop records only through here.
 */
export async function commitSessionStep(
  target: SessionStepState | RestoredSessionStep,
  decide: (view: SessionView) => readonly Transition[],
  options: {
    readonly origin: SessionEventOrigin;
    /** Where a relayed input batch came from; see `SessionStepPublication.inputSource`. */
    readonly inputSource?: string;
  },
): Promise<PublishedSessionEvents> {
  const { state } =
    "ctx" in target ? target.durableSession : readDurableSession(target.sessionState);
  const view = sessionView(storedProjection(state), state);
  const transitions = decide(view);
  if ("ctx" in target) return await commit(target, transitions, options);
  if (transitions.every((transition) => changesNothing(view, transition))) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  return await commit(await restoreSessionStep(target), transitions, options);
}

async function commit(
  restored: RestoredSessionStep,
  transitions: readonly Transition[],
  options: { readonly origin: SessionEventOrigin; readonly inputSource?: string },
): Promise<PublishedSessionEvents> {
  const { published } = await publishFromSessionStep(restored, {
    inputSource: options.inputSource,
    origin: options.origin,
    async publish(emit) {
      for (const transition of transitions) await publishTransition(transition, emit);
    },
    // Save onto the session the scope committed, which carries what its providers captured.
    updateSession: (session) => ({
      session: transitions.reduce((next, transition) => saveTransition(next, transition), session),
    }),
  });
  return published;
}

/** A transition that reports nothing and changes no record, as the machine decides with no work. */
function changesNothing(view: SessionView, transition: Transition): boolean {
  return (
    transition.turn === view.turn &&
    transition.events.length === 0 &&
    transition.signIns === undefined &&
    transition.relays === undefined &&
    transition.commit === undefined &&
    transition.clearsHistory === undefined
  );
}
