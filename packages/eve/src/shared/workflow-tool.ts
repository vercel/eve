/**
 * Reads the workflow id the bundler stamps on an authored `execute` whose
 * body is a `"use workflow"` function. The stamp is the only runtime trace of
 * the directive: the function itself is a stub that refuses direct calls.
 */
export function readWorkflowToolId(execute: unknown): string | undefined {
  if (typeof execute !== "function") return undefined;
  const workflowId = Reflect.get(execute, "workflowId");
  return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : undefined;
}
