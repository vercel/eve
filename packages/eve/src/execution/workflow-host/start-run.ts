import {
  workflowToolRunHookToken,
  type StartWorkflowToolRun,
} from "#execution/tools/workflow/start.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-references.js";

export const startWorkflowToolRun: StartWorkflowToolRun = async (input) => {
  const hookToken = workflowToolRunHookToken(input);
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
};
