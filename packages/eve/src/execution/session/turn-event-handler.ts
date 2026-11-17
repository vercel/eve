import type { ModelMessage } from "ai";

import type { SessionEventPublisher } from "#execution/publish-session-events.js";
import { throwIfTurnAborted, TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HandleEventFn } from "#harness/types.js";

export function createTurnEventHandler(input: {
  readonly abortSignal: AbortSignal;
  readonly canCancelTurn: boolean;
  readonly conversation: readonly ModelMessage[];
  readonly hookCancellation: AbortController;
  readonly publisher: SessionEventPublisher;
}): HandleEventFn {
  const { publisher } = input;
  let conversation = input.conversation;
  return async (publication, messages) => {
    if (messages !== undefined) conversation = messages;
    const written = await publisher.emit(publication);
    const ends = written.some(
      ({ event }) => event.type === "turn.settled" || event.type === "session.ended",
    );
    const cancelTurn =
      input.canCancelTurn && !ends
        ? ({ reason }: { readonly reason?: string }) =>
            input.hookCancellation.abort(new TurnCancelledError(reason))
        : undefined;
    await publisher.dispatcher.react(written, {
      abortSignal: input.abortSignal,
      conversation,
      cancelTurn,
      cancelBeforeTurn: cancelTurn,
    });
    throwIfTurnAborted(input.hookCancellation.signal);
  };
}
