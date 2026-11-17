import { readWorkflowFunctionId } from "#shared/workflow-function-id.js";

export interface WorkflowBody {
  readonly workflowId: string;
  readonly body: (...args: never[]) => unknown;
}

export function workflowBodyOf<F extends (...args: never[]) => unknown>(
  workflow: F,
  body: F,
): WorkflowBody | undefined {
  const workflowId = readWorkflowFunctionId(workflow);
  return workflowId === undefined ? undefined : { body, workflowId };
}
