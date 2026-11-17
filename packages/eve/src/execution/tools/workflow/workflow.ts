import { runWorkflowToolRun } from "#execution/tools/workflow/run.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { workflowRunHost } from "#execution/tools/workflow/workflow-run-host.js";

export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  await runWorkflowToolRun(input, workflowRunHost);
}
