/** The method a workflow tool defines, which decides how its calls run. */
export type WorkflowToolEntryPoint = "execute" | "task" | "serve";

export const WORKFLOW_TOOL_ENTRY_POINTS: readonly WorkflowToolEntryPoint[] = [
  "execute",
  "task",
  "serve",
];
