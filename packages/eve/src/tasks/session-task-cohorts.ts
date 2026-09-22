import type { SessionStateMap } from "#harness/types.js";
import { getBackgroundWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/** An entry without a join target starts its own cohort. */
export function getTaskCohortId(task: {
  readonly taskId: string;
  readonly cohortId?: string;
}): string {
  return task.cohortId ?? task.taskId;
}

export function getSessionTaskCohorts(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    getBackgroundWorkflowToolRuns(state)
      .filter(({ task }) => task.notifications !== "suppressed")
      .map(({ task }) => [task.taskId, getTaskCohortId(task)]),
  );
}
