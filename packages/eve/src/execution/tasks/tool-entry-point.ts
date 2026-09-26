import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { WorkflowToolEntryPoint } from "#tools/workflow-entry-point.js";

/**
 * The entry point a deferred tool's calls run through. Tools that aren't
 * workflow tools, such as agents, are called like `execute`.
 */
export function entryPointOf(
  definition: HarnessToolDefinition | undefined,
): WorkflowToolEntryPoint {
  const handling = definition?.behavior?.handling;
  if (handling?.kind === "dispatch" && handling.target.kind === "workflow-tool-call") {
    return handling.target.entryPoint;
  }
  return "execute";
}

/** Whether calls to the tool run as tasks: every call to a `task` or `serve` tool. */
export function startsTasks(definition: HarnessToolDefinition | undefined): boolean {
  return entryPointOf(definition) !== "execute";
}
