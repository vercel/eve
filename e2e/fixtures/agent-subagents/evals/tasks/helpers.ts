import type { EveEvalTurn } from "eve/evals";

/** Stream events of one eval session, in order. */
type SessionEvents = EveEvalTurn["events"];

/** The `task.started` data of every call to one agent. */
export function taskStarts(events: SessionEvents, name: string) {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === name ? [event.data] : [],
  );
}

/**
 * The agent ids from receipts the turn's calls to one agent returned. A
 * detached call's `task.started` can land after its turn ends, so the
 * receipt is the turn's own evidence of the call.
 */
export function receiptTaskIds(turn: EveEvalTurn, name: string): readonly string[] {
  return turn.toolCalls.flatMap((call) => {
    if (call.name !== name) return [];
    const output = call.output as { readonly status?: unknown; readonly taskId?: unknown } | null;
    return output?.status === "working" && typeof output.taskId === "string" ? [output.taskId] : [];
  });
}

/** The task ids each `task.result` message delivered, one entry per message. */
export function taskResultDeliveries(events: SessionEvents): readonly (readonly string[])[] {
  return events.flatMap((event) =>
    event.type === "message.received" && event.data.kind === "task.result"
      ? [event.data.taskIds ?? []]
      : [],
  );
}

/**
 * The assistant's reply at the turn's first waiting boundary, where an
 * interactive turn holds on its tasks and shows what it has so far.
 */
export function heldReply(turn: EveEvalTurn): string | undefined {
  const boundary = turn.events.findIndex(
    (event) => event.type === "turn.completed" && event.data.held === true,
  );
  if (boundary < 0) return undefined;
  return turn.events
    .slice(0, boundary)
    .flatMap((event) =>
      event.type === "message.completed" &&
      event.data.message !== null &&
      event.data.finishReason !== "tool-calls"
        ? [event.data.message]
        : [],
    )
    .at(-1);
}
