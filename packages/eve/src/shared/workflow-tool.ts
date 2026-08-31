/** Reads the `workflowId` the bundler stamps on a workflow reference, as `start(fn)` does. */
export function readWorkflowToolId(execute: unknown): string | undefined {
  if (typeof execute !== "function") return undefined;
  const workflowId = Reflect.get(execute, "workflowId");
  return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : undefined;
}
