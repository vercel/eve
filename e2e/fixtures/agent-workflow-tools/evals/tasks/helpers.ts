import type { EveEvalContext, EveEvalLiveTurn, EveEvalTurn } from "eve/evals";

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

/** Waits until the live turn has started `count` tasks for one tool. */
export async function waitForStarts(
  t: EveEvalContext,
  live: EveEvalLiveTurn,
  name: string,
  count: number,
): Promise<void> {
  await live.waitForEvent("task.started", { data: { name } });
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (startedTaskIds(live.events, name).length >= count) return;
    await t.sleep(250);
  }
  throw new Error(`Expected ${count} ${name} tasks to start.`);
}
