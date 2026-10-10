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
  "action.input.appended": true,
  "action.partial": true,
  "action.result": true,
  "actions.requested": true,
  "agent.started": false,
  "approval.candidate": true,
  "approval.settled": true,
  "authorization.completed": true,
  "authorization.required": true,
  "compaction.completed": true,
  "compaction.requested": true,
  "context.cleared": false,
  "input.requested": true,
  "input.resolved": true,
  "message.appended": true,
  "message.completed": true,
  "message.received": true,
  "reasoning.appended": true,
  "reasoning.completed": true,
  "result.completed": true,
  "session.completed": false,
  "session.failed": false,
  "session.started": true,
  "session.waiting": false,
  "step.completed": true,
  "step.failed": false,
  "step.started": true,
  "task.settled": false,
  "task.started": false,
  "turn.cancelled": false,
  "turn.completed": false,
  "turn.failed": false,
  "turn.started": true,
  "turn.waiting": false,
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
    await publisher.dispatcher.runHooks(written, (event) =>
      input.canCancelTurn && isHookCancellableEvent(event.type) ? cancelTurn : undefined,
    );
    throwIfTurnAborted(input.hookCancellation.signal);
    for (const { event } of written) {
      await participants.receive(event, readsHistory(event.type) ? messages : undefined);
    }
  };
}
