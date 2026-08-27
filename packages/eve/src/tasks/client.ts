import type { TaskView } from "#tasks/types.js";

type WithoutExecutor<T> = T extends unknown ? Omit<T, "executor"> : never;

/** Client-safe task state with private executor routing removed. */
export type ClientTaskView = WithoutExecutor<TaskView>;

/** Projects one durable task view onto the public client contract. */
export function toClientTaskView(view: TaskView): ClientTaskView {
  const { executor: _executor, ...clientView } = view;
  return clientView;
}
