import type { SessionStreamEvent } from "eve/client";

/** A call that started or reached a task. */
export interface TaskCall {
  readonly callId: string;
  readonly taskId: string;
  readonly turnId?: string;
}

/** How a call a task served settled. */
export interface TaskCallSettlement {
  readonly callId: string;
  readonly outcome: string;
  readonly output?: unknown;
}

/**
 * Whether eve held the turn: the model ended a run with a reply while its
 * tasks worked, and the turn paused instead of ending. A pause after an
 * `eve__task_wait` call is the model waiting, not a hold.
 */
export function heldTurn(events: readonly SessionStreamEvent[]): boolean {
  let replied = false;
  for (const event of events) {
    if (event.type === "content.completed" && event.data.kind === "text") {
      replied = event.data.phase === "reply";
    } else if (event.type === "call.requested") replied = false;
    else if (event.type === "turn.paused" && replied) return true;
  }
  return false;
}

/** Every call that started or reached a task of `tool`, in stream order. */
export function taskStarts(
  events: readonly SessionStreamEvent[],
  tool: string,
): readonly TaskCall[] {
  const tasks = new Set(
    events.flatMap((event) =>
      event.type === "task.started" && event.data.name === tool ? [event.data.taskId] : [],
    ),
  );
  return events.flatMap((event) =>
    event.type === "call.started" && event.data.taskId !== undefined && tasks.has(event.data.taskId)
      ? [{ callId: event.data.callId, taskId: event.data.taskId, turnId: event.scope?.turnId }]
      : [],
  );
}

/** How every call in `callIds` settled, in stream order. */
export function settlementsOf(
  events: readonly SessionStreamEvent[],
  callIds: readonly string[],
): readonly TaskCallSettlement[] {
  return events.flatMap((event) =>
    event.type === "call.settled" && callIds.includes(event.data.callId)
      ? [{ callId: event.data.callId, outcome: event.data.outcome, output: event.data.output }]
      : [],
  );
}

/** The text of every assistant message that completed, interim or final, in stream order. */
export function assistantMessages(events: readonly SessionStreamEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "content.completed" &&
    event.data.kind === "text" &&
    typeof event.data.value === "string"
      ? [event.data.value]
      : [],
  );
}

/** Index of the first `call.requested` event that calls `tool`, or -1. */
export function firstRequestOf(events: readonly SessionStreamEvent[], tool: string): number {
  return events.findIndex(
    (event) => event.type === "call.requested" && event.data.capability.name === tool,
  );
}

/** Index of the first `call.settled` event for any call in `callIds`, or -1. */
export function firstSettlementOf(
  events: readonly SessionStreamEvent[],
  callIds: readonly string[],
): number {
  return events.findIndex(
    (event) => event.type === "call.settled" && callIds.includes(event.data.callId),
  );
}

/** The `reportId` a completed `compile_report` call returned. */
export function reportIdOf(settlement: TaskCallSettlement): string | undefined {
  const output = settlement.output;
  if (typeof output !== "object" || output === null || !("reportId" in output)) return undefined;
  const reportId = output.reportId;
  return typeof reportId === "string" ? reportId : undefined;
}
