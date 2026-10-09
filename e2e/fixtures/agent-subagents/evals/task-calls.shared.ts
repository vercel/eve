import type { SessionStreamEvent } from "eve/client";

/** A call that started or reached a task, with the turn it was made in. */
export interface TaskCallStart {
  readonly callId: string;
  readonly taskId: string;
  readonly turnId?: string;
}

/**
 * Every call that started or reached a task of `name`, in stream order. A task starts once
 * (`task.started`); each call it serves starts against it (`call.started {taskId}`).
 */
export function callsReachingTasks(
  events: readonly SessionStreamEvent[],
  name: string,
): readonly TaskCallStart[] {
  const tasks = new Set(
    events.flatMap((event) =>
      event.type === "task.started" && event.data.name === name ? [event.data.taskId] : [],
    ),
  );
  return events.flatMap((event) =>
    event.type === "call.started" && event.data.taskId !== undefined && tasks.has(event.data.taskId)
      ? [{ callId: event.data.callId, taskId: event.data.taskId, turnId: event.scope?.turnId }]
      : [],
  );
}
