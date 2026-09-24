import type {
  WorkflowToolRunAddress,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
} from "#execution/workflow-runtime.js";

/**
 * The run's command hook. It derives from the task, so a start retried after
 * the run began starts a second run that cannot claim the hook and exits
 * before running the body.
 */
export function workflowTaskHookToken(sessionId: string, taskId: string): string {
  return `eve:workflow-task:${sessionId}:${taskId}`;
}

/** Starts the run for one workflow task. Call from a `"use step"` body. */
export async function startWorkflowToolRun(
  input: Omit<WorkflowToolRunInput, "hookToken">,
): Promise<WorkflowToolRunAddress> {
  const hookToken = workflowTaskHookToken(input.session.id, input.taskId);
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
}
