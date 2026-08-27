import type { EveMessageData, EveTask } from "#client/message-reducer-types.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";

/** Folds one durable task event into the render-ready task list. */
export function upsertTask(
  data: EveMessageData,
  event: Extract<EveAgentReducerEvent, { type: "task.updated" }>,
): EveMessageData {
  const existingIndex = data.tasks.findIndex((task) => task.taskId === event.data.task.taskId);
  const existing = data.tasks[existingIndex];
  const terminal =
    event.data.task.status === "completed" ||
    event.data.task.status === "failed" ||
    event.data.task.status === "cancelled";
  if (existing?.completedAt !== undefined && !terminal) return data;
  const task: EveTask = {
    ...event.data.task,
    activity: event.data.message ?? existing?.activity,
    completedAt: terminal ? (existing?.completedAt ?? event.meta.at) : undefined,
    createdAt: existing?.createdAt ?? event.meta.at,
    updatedAt: event.meta.at,
  };
  if (existingIndex === -1) return { ...data, tasks: [...data.tasks, task] };
  return {
    ...data,
    tasks: [...data.tasks.slice(0, existingIndex), task, ...data.tasks.slice(existingIndex + 1)],
  };
}
