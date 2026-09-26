/** The method a workflow tool defines, which decides how its calls run. */
export type WorkflowToolEntryPoint = "execute" | "task";

// Dependency-free so the build's directive transform can read it too.
export const WORKFLOW_TOOL_ENTRY_POINTS: readonly WorkflowToolEntryPoint[] = ["execute", "task"];
