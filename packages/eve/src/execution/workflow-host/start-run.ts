import {
  workflowToolRunHookToken,
  type StartWorkflowToolRun,
} from "#execution/tools/workflow/start.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-references.js";

/**
 * Starts a new Workflow run on the current deployment for each dispatch attempt. Call from a
 * `"use step"` body.
 */
export const startWorkflowToolRun: StartWorkflowToolRun = async (input) => {
  const hookToken = workflowToolRunHookToken(input);
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
};
