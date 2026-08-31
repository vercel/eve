/** The Workflow SDK runtime resolves a run's function from this global; eve's transform fills it. */
export const WORKFLOW_REGISTRY_GLOBAL = "__private_workflows";

export function readRegisteredWorkflow(workflowId: string): unknown {
  const registry = (globalThis as Record<string, unknown>)[WORKFLOW_REGISTRY_GLOBAL];
  return registry instanceof Map ? registry.get(workflowId) : undefined;
}
