/** Reads build-generated workflow identity from a transformed callback. */
export function readWorkflowFunctionId(value: unknown): string | undefined {
  if (typeof value !== "function") return undefined;
  const workflowId = Reflect.get(value, "workflowId");
  return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : undefined;
}
