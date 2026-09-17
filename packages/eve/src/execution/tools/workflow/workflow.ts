import { runWorkflowToolInvocation } from "#execution/tools/workflow/invocation.js";
import type {
  BackgroundWorkflowToolRunInput,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";

/** Runs a workflow invocation owned by either the waiting turn or its session. */
export async function workflowToolRunWorkflow(
  input: WorkflowToolRunInput | BackgroundWorkflowToolRunInput,
): Promise<void> {
  "use workflow";

  await runWorkflowToolInvocation(input);
}
