import type { SessionParticipants } from "#execution/participants.js";
import type { SessionEventPublisher } from "#execution/publish-session-events.js";
import { throwIfTurnAborted, TurnCancelledError } from "#harness/turn-cancellation.js";
import { readsHistory } from "#harness/session-machine/commit.js";
import type { HandleEventFn } from "#harness/types.js";
import type { HookEventType } from "#public/definitions/hook.js";
/**
 * Whether `ctx.cancel()` from a hook on each event may stop the running turn.
 * Total over hook events, so a new event must be classified before it compiles.
 * Settlement events stay false: cancelling there would give the turn a second terminal.
 */
const HOOK_CANCELLABLE_EVENTS = {
  "call.input": true,
  "child.opened": false,
  "interaction.opened": true,
  // A settlement is a terminal fact: cancelling there would give its work a second terminal.
  "interaction.settled": false,
  "call.progress": true,
  "call.requested": true,
  "call.settled": true,
  "call.started": true,
  "content.completed": true,
  "content.delta": true,
  "context.settled": true,
  "context.started": true,
  "delivery.admitted": true,
  "delivery.consumed": true,
  "delivery.settled": false,
  "response.admitted": true,
  "response.settled": false,
  "response.submitted": true,
  "model.requested": true,
  "model.settled": true,
  "model.started": true,
  "session.ended": false,
  "session.started": true,
  "task.ended": false,
  "task.started": false,
  "turn.paused": false,
  "turn.resumed": true,
  "turn.settled": false,
  "turn.started": true,
  "usage.recorded": true,
} as const satisfies Record<HookEventType, boolean>;

/** True when a hook on this event type may cancel the running turn. */
export function isHookCancellableEvent(type: string): boolean {
  return (HOOK_CANCELLABLE_EVENTS as Readonly<Record<string, boolean>>)[type] === true;
}

/**
 * Publishes one turn event or commit, runs its hooks, then the participants that receive each
 * event. A hook's `ctx.cancel()` aborts the turn signal at once; the commit's remaining hooks
 * still run, then the turn stops before its participants or its next model call.
 */
export function createTurnEventHandler(input: {
  /** False for clear and compact requests, which run outside any turn. */
  readonly canCancelTurn: boolean;
  readonly hookCancellation: AbortController;
  readonly participants: SessionParticipants;
  readonly publisher: SessionEventPublisher;
}): HandleEventFn {
  const { participants, publisher } = input;
  const cancelTurn = () => input.hookCancellation.abort(new TurnCancelledError());
  return async (publication, messages) => {
    const written = await publisher.emit(publication);
    // A commit that ended the turn or the session leaves nothing for a hook to stop.
    const ends = written.some(
      ({ event }) => event.type === "turn.settled" || event.type === "session.ended",
    );
    await publisher.dispatcher.runHooks(written, (event) =>
      input.canCancelTurn && !ends && isHookCancellableEvent(event.type) ? cancelTurn : undefined,
    );
    throwIfTurnAborted(input.hookCancellation.signal);
    for (const { event } of written) {
      await participants.receive(event, readsHistory(event.type) ? messages : undefined);
    }
  };
}
