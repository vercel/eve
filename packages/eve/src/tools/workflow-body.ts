import { readWorkflowFunctionId } from "#internal/workflow/reference.js";

/**
 * A workflow tool's body as a plain function, under the id its `"use workflow"` function has.
 * Workflow registers the transformed function itself; a host without Workflow runs this body in
 * its place.
 */
export interface WorkflowBody {
  readonly workflowId: string;
  readonly body: (...args: never[]) => Promise<unknown>;
}

/**
 * `body` as the plain twin of `workflow`, a `"use workflow"` function, under the id the build
 * that transformed it stamped (a dev build's and a package's differ). `undefined` when no build
 * transformed it: then no tool names it as a workflow, so there's nothing to register.
 */
export function workflowBodyOf<F extends (...args: never[]) => Promise<unknown>>(
  workflow: F,
  body: F,
): WorkflowBody | undefined {
  const workflowId = readWorkflowFunctionId(workflow);
  return workflowId === undefined ? undefined : { body, workflowId };
}
