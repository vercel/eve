import { workflowBodyOf, type WorkflowBody } from "#tools/workflow-body.js";

/**
 * `workflow`'s plain `body`, under the id Workflow's transform stamped on `workflow`, for a host
 * without Workflow to run. The integration tier applies that transform to all of `src/`, so a
 * missing stamp means the transform didn't run on this module, which this reports instead of
 * guessing an id.
 */
export function stampedWorkflowBody<F extends (...args: never[]) => Promise<unknown>>(
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
