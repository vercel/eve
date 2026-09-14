import type { SessionStateMap } from "#harness/types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";

/** Session-state key for the parent's task index; mutable task records live in task runs. */
export const SESSION_TASKS_STATE_KEY = "eve.tasks";
export const SESSION_TASKS_STATE_VERSION = 2;

/** An entry without a join target starts its own cohort. */
export function getTaskCohortId(task: {
  readonly taskId: string;
  readonly cohortId?: string;
}): string {
  return task.cohortId ?? task.taskId;
}

/**
 * Reads cohort identities and settlement for workflow-side completion batching.
 * Full task validation stays in getSessionTaskIndex on the step side, so
 * the workflow bundle does not retain the task schemas and their dependencies.
 */
export function getSessionTaskCohorts(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, { readonly cohortId: string; readonly settled: boolean }> {
  const cohorts = new Map<string, { readonly cohortId: string; readonly settled: boolean }>();
  const raw = state?.[SESSION_TASKS_STATE_KEY];
  if (raw === undefined) return cohorts;

  if (!isObject(raw) || raw.version !== SESSION_TASKS_STATE_VERSION) {
    throw new Error(
      `Unsupported task index version under session state key "${SESSION_TASKS_STATE_KEY}".`,
    );
  }
  if (!Array.isArray(raw.tasks)) {
    throw new Error(
      `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": expected tasks array.`,
    );
  }
  for (const task of raw.tasks) {
    if (
      !isObject(task) ||
      !isNonEmptyString(task.taskId) ||
      !isNonEmptyString(task.createdByTurnId) ||
      (task.cohortId !== undefined && !isNonEmptyString(task.cohortId)) ||
      cohorts.has(task.taskId)
    ) {
      throw new Error(
        `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": invalid task cohort identity.`,
      );
    }
    cohorts.set(task.taskId, {
      cohortId: getTaskCohortId({ taskId: task.taskId, cohortId: task.cohortId }),
      settled: task.terminalView !== undefined,
    });
  }
  return cohorts;
}
