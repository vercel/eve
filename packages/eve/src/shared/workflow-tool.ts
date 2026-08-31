/**
 * Reads the id the Workflow SDK stamps on a workflow reference: the bundler
 * replaces a `"use workflow"` function with a stub carrying `workflowId`,
 * the property `start(fn)` resolves. The compiler reads it once from a
 * tool's `execute` and records it on the compiled definition; nothing at
 * runtime inspects the function.
 */
export function readWorkflowToolId(execute: unknown): string | undefined {
  if (typeof execute !== "function") return undefined;
  const workflowId = Reflect.get(execute, "workflowId");
  return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : undefined;
}
