export function workflowToolContextErrorMessage(helper: "agent" | "ask"): string {
  return (
    `${helper}() from "eve/workflow" requires the context of an eve workflow tool. ` +
    "Call it from a tool's \"use workflow\" body and pass that body's ctx. " +
    "Channel handlers, schedule handlers, ordinary tools, and steps do not provide this context."
  );
}

export function workflowCallbackErrorMessage(
  kind: "channel" | "schedule" | "tool" | "step",
): string {
  return (
    `"use workflow" is not supported on ${kind} callbacks. ` +
    "Put it on a tool's execute function. Adding the directive to a handler does not start a workflow tool."
  );
}
