import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedDispatchTarget } from "#tools/behavior.js";
import type { WorkflowToolEntryPoint } from "#tools/workflow-entry-point.js";

/**
 * The entry point a deferred tool's calls run through. Every agent tool is a
 * `serve` tool; tools that dispatch nowhere are called like `execute`.
 */
export function entryPointOf(
  definition: HarnessToolDefinition | undefined,
): WorkflowToolEntryPoint {
  const target = dispatchTargetOf(definition);
  if (target === undefined) return "execute";
  if (target.kind === "workflow-tool-call") return target.entryPoint;
  return "serve";
}

/** Whether calls to the tool run as tasks: every call to an agent, `task`, or `serve` tool. */
export function startsTasks(definition: HarnessToolDefinition | undefined): boolean {
  return entryPointOf(definition) !== "execute";
}

/** Whether the tool is an agent: a declared, remote, dynamic, or root-copy agent. */
export function isAgentTool(definition: HarnessToolDefinition | undefined): boolean {
  const target = dispatchTargetOf(definition);
  return target !== undefined && target.kind !== "workflow-tool-call";
}

function dispatchTargetOf(
  definition: HarnessToolDefinition | undefined,
): PreparedDispatchTarget | undefined {
  const handling = definition?.behavior?.handling;
  if (handling?.kind !== "dispatch") return undefined;
  return handling.target;
}
