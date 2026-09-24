import type {
  WorkflowToolRunAddress,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
} from "#execution/workflow-runtime.js";

/** Starts a new run for each dispatch attempt. Call from a `"use step"` body. */
export async function startWorkflowToolRun(
  input: Omit<WorkflowToolRunInput, "hookToken">,
): Promise<WorkflowToolRunAddress> {
  const hookToken = crypto.randomUUID();
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
}
