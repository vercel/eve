import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cancelSessionTaskStep } from "#execution/tasks/parent/cancel-session-task-step.js";

/** Coordinates task cancellation against a parent session's current durable snapshot. */
export function createSessionTaskCanceller(cursor: SessionStateCursor) {
  const pending = new Set<string>();
  const cancel = async (taskId: string) =>
    await cancelSessionTaskStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
      taskId,
    });

  return {
    cancelActive: async (taskId: string) => {
      const result = await cancel(taskId);
      if (result === "not-found") pending.add(taskId);
      return result === "cancelled";
    },
    cancelParked: async (taskId: string) => (await cancel(taskId)) === "cancelled",
    drain: async () => {
      const cancelled: string[] = [];
      for (const taskId of pending) {
        if ((await cancel(taskId)) === "cancelled") cancelled.push(taskId);
        pending.delete(taskId);
      }
      return cancelled;
    },
  };
}
