declare global {
  var __private_workflows: Map<string, unknown> | undefined;
}

export const WORKFLOW_REGISTRY_GLOBAL = "__private_workflows";

export function readRegisteredWorkflow(workflowId: string): unknown {
  return globalThis[WORKFLOW_REGISTRY_GLOBAL]?.get(workflowId);
}
