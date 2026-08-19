import type { SessionStateMap } from "#harness/types.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index-state-key.js";
import type { ReadyTaskStatus } from "#tasks/types.js";

interface ObservedReadyTaskEntry {
  readonly lastPeekedReadyStatus?: ReadyTaskStatus;
  readonly taskId: string;
}

/**
 * Schema-free read of the task observations needed by the workflow driver.
 *
 * Trust boundary: only session-index.ts writes `eve.tasks`, and its step-side
 * readers validate the complete store with zod. This query validates only the
 * fields that can suppress a delivery so compiled zod stays out of the durable
 * workflow bundle. Malformed observation data fails open and preserves the wake.
 */
export function isObservedReadyTaskDelivery(
  state: SessionStateMap | undefined,
  deliveryId: string | undefined,
): boolean {
  if (deliveryId === undefined) return false;
  const entries = readObservedReadyTaskEntries(state);
  if (entries === undefined) return false;
  for (const entry of entries) {
    const status = entry.lastPeekedReadyStatus;
    if (status === undefined) continue;
    if (deliveryId.startsWith(`${entry.taskId}:update:`)) return true;
    if (deliveryId === `${entry.taskId}:ready:${status}`) return true;
  }
  return false;
}

function readObservedReadyTaskEntries(
  state: SessionStateMap | undefined,
): readonly ObservedReadyTaskEntry[] | undefined {
  const raw = state?.[SESSION_TASKS_STATE_KEY];
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const tasks = (raw as { readonly tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return undefined;
  for (const task of tasks) {
    if (!isObservedReadyTaskEntry(task)) return undefined;
  }
  return tasks;
}

function isObservedReadyTaskEntry(value: unknown): value is ObservedReadyTaskEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as {
    readonly lastPeekedReadyStatus?: unknown;
    readonly taskId?: unknown;
  };
  return (
    typeof entry.taskId === "string" &&
    entry.taskId.length > 0 &&
    (entry.lastPeekedReadyStatus === undefined || isReadyTaskStatus(entry.lastPeekedReadyStatus))
  );
}

function isReadyTaskStatus(value: unknown): value is ReadyTaskStatus {
  return (
    value === "input_required" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}
