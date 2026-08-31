/**
 * The driver's workflow registry: the Workflow SDK runtime resolves a run's
 * function with `globalThis.__private_workflows.get(name)`, and eve's
 * transform emits the banner that creates the map and one `set` per
 * `"use workflow"` function. Dependency-free: the transform and the replayed
 * body both read it from here.
 */
export const WORKFLOW_REGISTRY_GLOBAL = "__private_workflows";

export function readRegisteredWorkflow(workflowId: string): unknown {
  const registry = (globalThis as Record<string, unknown>)[WORKFLOW_REGISTRY_GLOBAL];
  return registry instanceof Map ? registry.get(workflowId) : undefined;
}
