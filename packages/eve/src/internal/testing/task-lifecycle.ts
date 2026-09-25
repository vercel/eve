import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

interface TaskLifecycle {
  generation: number;
  /** The latest generation started and has not settled. */
  open: boolean;
  ended: boolean;
  resumable?: boolean;
}

/**
 * The ways a session stream breaks the task lifecycle, or none. Per task:
 * generations start in order from 1, each generation's `task.started`
 * precedes its one `task.settled`, a generation settles before the next
 * starts, and one `task.ended` follows the last settle, after which the task
 * publishes nothing. A task that is not resumable ends right after its
 * generation settles, and a stream that reached its session's end ended
 * every task first.
 */
export function taskLifecycleViolations(
  events: readonly UnstampedMessageStreamEvent[],
): readonly string[] {
  const tasks = new Map<string, TaskLifecycle>();
  const violations: string[] = [];
  let sessionEnded = false;
  for (const [index, event] of events.entries()) {
    if (event.type === "session.completed" || event.type === "session.failed") sessionEnded = true;
    if (
      event.type !== "task.started" &&
      event.type !== "task.settled" &&
      event.type !== "task.ended"
    ) {
      continue;
    }
    const { taskId } = event.data;
    const where = `${event.type} at event ${index} for ${taskId}`;
    let task = tasks.get(taskId);
    if (task === undefined) {
      task = { ended: false, generation: 0, open: false };
      tasks.set(taskId, task);
    }
    if (task.ended) {
      violations.push(`${where} follows its task.ended`);
      continue;
    }
    switch (event.type) {
      case "task.started":
        if (task.open) violations.push(`${where}: generation ${task.generation} has not settled`);
        if (event.data.generation !== task.generation + 1) {
          violations.push(
            `${where}: generation ${event.data.generation} follows ${task.generation}`,
          );
        }
        task.generation = event.data.generation;
        task.open = true;
        task.resumable = event.data.resumable;
        break;
      case "task.settled":
        if (!task.open || event.data.generation !== task.generation) {
          violations.push(`${where}: generation ${event.data.generation} has no open task.started`);
        }
        task.open = false;
        break;
      case "task.ended":
        if (task.open) violations.push(`${where}: generation ${task.generation} has not settled`);
        if (task.generation === 0) violations.push(`${where}: the task never started`);
        task.ended = true;
        break;
    }
  }
  for (const [taskId, task] of tasks) {
    if (task.ended) continue;
    if (sessionEnded) violations.push(`${taskId} did not end before its session did`);
    else if (task.resumable === false && !task.open) {
      violations.push(`${taskId} is not resumable and did not end when its generation settled`);
    }
  }
  return violations;
}
