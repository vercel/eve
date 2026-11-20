import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

export function stampedWorkflowBody<F extends (...args: never[]) => unknown>(
  workflow: F,
  body: F,
): WorkflowBody {
  const stamped = workflowBodyOf(workflow, body);
  if (stamped === undefined) {
    throw new Error(
      `"${workflow.name}" has no workflow id: Workflow's transform didn't run on its module.`,
    );
  }
  return stamped;
}
