import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { isReadyTaskStatus, type TaskStatus, type TaskView } from "#tasks/types.js";

/** Additive state kept separate from the strict task index for pinned-driver compatibility. */
export const SESSION_TASK_OBSERVATIONS_STATE_KEY = "eve.taskObservations";

type ReadyTaskStatus = Exclude<TaskStatus, "working">;
type ReadyTaskObservations = Readonly<Record<string, ReadyTaskStatus>>;

const readyTaskObservationsSchema: z.ZodType<ReadyTaskObservations> = z.record(
  z.string().min(1),
  z.enum(["input_required", "completed", "failed", "cancelled"]),
);

/** Records which ready task views a successful `task_peek` exposed to the parent model. */
export function recordObservedReadyTaskViews(
  session: HarnessSession,
  views: readonly TaskView[],
): HarnessSession {
  const observed = { ...readObservedReadyTasks(session.state) };
  let changed = false;
  for (const view of views) {
    const status = isReadyTaskStatus(view.status) ? view.status : undefined;
    if (observed[view.taskId] === status) continue;
    changed = true;
    if (status === undefined) {
      delete observed[view.taskId];
    } else {
      observed[view.taskId] = status;
    }
  }
  return changed
    ? { ...session, state: writeObservedReadyTasks(session.state, observed) }
    : session;
}

/** Clears a nonterminal ready observation when an input answer resumes its task. */
export function clearObservedReadyTask(
  state: SessionStateMap | undefined,
  taskId: string,
): SessionStateMap | undefined {
  const observed = { ...readObservedReadyTasks(state) };
  if (observed[taskId] === undefined) return state;
  delete observed[taskId];
  return writeObservedReadyTasks(state, observed);
}

/** True when a task update/readiness delivery was made redundant by `task_peek`. */
export function isObservedReadyTaskDelivery(
  state: SessionStateMap | undefined,
  deliveryId: string | undefined,
): boolean {
  if (deliveryId === undefined) return false;
  for (const [taskId, status] of Object.entries(readObservedReadyTasks(state))) {
    if (deliveryId.startsWith(`${taskId}:update:`)) return true;
    if (deliveryId === `${taskId}:ready:${status}`) return true;
  }
  return false;
}

/** Reads and validates observations instead of silently ignoring corrupt suppression state. */
export function readObservedReadyTasks(state: SessionStateMap | undefined): ReadyTaskObservations {
  const raw = state?.[SESSION_TASK_OBSERVATIONS_STATE_KEY];
  if (raw === undefined) return {};
  const parsed = readyTaskObservationsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Corrupt task observations under session state key "${SESSION_TASK_OBSERVATIONS_STATE_KEY}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function writeObservedReadyTasks(
  state: SessionStateMap | undefined,
  observed: ReadyTaskObservations,
): SessionStateMap | undefined {
  const next = { ...state };
  if (Object.keys(observed).length === 0) {
    delete next[SESSION_TASK_OBSERVATIONS_STATE_KEY];
  } else {
    next[SESSION_TASK_OBSERVATIONS_STATE_KEY] = observed;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}
