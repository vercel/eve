import type { EveEvalLiveTurn, EveEvalTurn } from "eve/evals";

/** Stream events of one eval turn or session, in order. */
type Events = EveEvalTurn["events"];

/** The task IDs each `task.result` message delivered, one entry per message. */
export function taskResultDeliveries(events: Events): readonly (readonly string[])[] {
  return events.flatMap((event) =>
    event.type === "message.received" && event.data.kind === "task.result"
      ? [event.data.taskIds ?? []]
      : [],
  );
}

/** Task IDs of the tasks one tool started: the first generation of each. */
export function startedTaskIds(events: Events, name: string): readonly string[] {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === name && event.data.generation === 1
      ? [event.data.taskId]
      : [],
  );
}

/** The `task.started` data of every generation of one tool's tasks, in order. */
export function taskStarts(events: Events, name: string) {
  return events.flatMap((event) =>
    event.type === "task.started" && event.data.name === name ? [event.data] : [],
  );
}

/** Waits until the live turn has started `count` tasks for one tool, and returns their IDs. */
export async function waitForStarts(
  live: EveEvalLiveTurn,
  name: string,
  count: number,
): Promise<readonly string[]> {
  const taskIds: string[] = [];
  while (taskIds.length < count) {
    const started = await live.waitForEvent("task.started", {
      data: { generation: 1, name, taskId: (taskId) => !taskIds.includes(taskId) },
    });
    taskIds.push(started.data.taskId);
  }
  return taskIds;
}

/**
 * The result a turn's model read for one generation of a task: from a
 * `task_wait`, or from the `task.result` message that delivered it when it
 * settled before any wait.
 */
export function receivedResult(
  turn: EveEvalTurn,
  taskId: string,
  generation: number,
): "message" | "wait" | undefined {
  const settled = turn.events.findIndex(
    (event) =>
      event.type === "task.settled" &&
      event.data.taskId === taskId &&
      event.data.generation === generation,
  );
  if (settled < 0) return undefined;
  const waited = turn.toolCalls.some((call) => {
    const output = call.output as { readonly status?: unknown; readonly taskId?: unknown } | null;
    return call.name === "task_wait" && output?.status === "settled" && output.taskId === taskId;
  });
  if (waited) return "wait";
  return turn.events
    .slice(settled)
    .some(
      (event) =>
        event.type === "message.received" &&
        event.data.kind === "task.result" &&
        event.data.taskIds?.includes(taskId) === true,
    )
    ? "message"
    : undefined;
}
