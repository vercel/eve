import type { ModelMessage } from "ai";

import type { SessionEventPublisher } from "#execution/publish-session-events.js";
import { throwIfTurnAborted, TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HandleEventFn } from "#harness/types.js";

/**
 * Publishes one turn event or commit, then runs the session's reactions with the conversation as
 * of the commit. A hook's `cancel()` aborts the turn signal; the commit's remaining reactions still
 * run, then the turn stops before its next model call.
 */
export function createTurnEventHandler(input: {
  readonly abortSignal: AbortSignal;
  /** False for clear and compact requests, which run outside any turn. */
  readonly canCancelTurn: boolean;
  /** The conversation the step starts from, until a commit hands a newer one. */
  readonly conversation: readonly ModelMessage[];
  readonly hookCancellation: AbortController;
  readonly publisher: SessionEventPublisher;
}): HandleEventFn {
  const { publisher } = input;
  let conversation = input.conversation;
  return async (publication, messages) => {
    if (messages !== undefined) conversation = messages;
    const written = await publisher.emit(publication);
    // A commit that ended the turn or the session leaves nothing for a hook to stop.
    const ends = written.some(
      ({ event }) => event.type === "turn.settled" || event.type === "session.ended",
    );
    await publisher.dispatcher.react(written, {
      abortSignal: input.abortSignal,
      conversation,
      ...(input.canCancelTurn && !ends
        ? { cancelTurn: () => input.hookCancellation.abort(new TurnCancelledError()) }
        : {}),
    });
    throwIfTurnAborted(input.hookCancellation.signal);
  };
}
