import type {
  MessageStreamEvent,
  TaskSettledStreamEvent,
  TaskStartedStreamEvent,
} from "eve/client";

/**
 * Whether eve held the turn: the model ended a step with a reply while its
 * tasks worked, and the turn parked with `turn.waiting` instead of ending. A
 * `turn.waiting` after a `eve__task_wait` call is the model waiting, not a hold.
 */
export function heldTurn(events: readonly MessageStreamEvent[]): boolean {
  let replied = false;
  for (const event of events) {
    if (event.type === "message.completed") replied = event.data.finishReason === "stop";
    else if (event.type === "actions.requested") replied = false;
    else if (event.type === "turn.waiting" && replied) return true;
  }
  return false;
}

/** Every call that started or reached a task of `tool`, in stream order. */
export function taskStarts(
  events: readonly MessageStreamEvent[],
  tool: string,
): readonly TaskStartedStreamEvent["data"][] {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === tool ? [event.data] : [],
  );
}

/** How every call in `callIds` settled, in stream order. */
export function settlementsOf(
  events: readonly MessageStreamEvent[],
  callIds: readonly string[],
): readonly TaskSettledStreamEvent["data"][] {
  return events.flatMap((event) =>
    event.type === "task.settled" && callIds.includes(event.data.callId) ? [event.data] : [],
  );
}

/** The text of every assistant message that completed, interim or final, in stream order. */
export function assistantMessages(events: readonly MessageStreamEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "message.completed" ? [event.data.message] : [],
  );
}

/** Index of the first `actions.requested` event that calls `tool`, or -1. */
export function firstRequestOf(events: readonly MessageStreamEvent[], tool: string): number {
  return events.findIndex(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some((action) => action.kind === "tool-call" && action.toolName === tool),
  );
}

/** Index of the first `task.settled` event for any call in `callIds`, or -1. */
export function firstSettlementOf(
  events: readonly MessageStreamEvent[],
  callIds: readonly string[],
): number {
  return events.findIndex(
    (event) => event.type === "task.settled" && callIds.includes(event.data.callId),
  );
}

/** The `reportId` a completed `compile_report` call returned. */
export function reportIdOf(settlement: TaskSettledStreamEvent["data"]): string | undefined {
  const output = settlement.output;
  if (typeof output !== "object" || output === null || !("reportId" in output)) return undefined;
  const reportId = output.reportId;
  return typeof reportId === "string" ? reportId : undefined;
}
