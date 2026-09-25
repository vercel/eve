export function workflowToolContextErrorMessage(helper: "agent" | "ask"): string {
  return `ctx.${helper}() requires a defineWorkflowTool() executor context. Call it inside the workflow tool body.`;
}

export function workflowCallbackErrorMessage(kind: "channel" | "schedule"): string {
  return (
    `"use workflow" is not supported on ${kind} callbacks. ` +
    'Use defineWorkflowTool() from "eve/tools" to author a workflow tool.'
  );
}
