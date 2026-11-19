import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedDispatchTarget } from "#tools/behavior.js";
import type { WorkflowToolEntryPoint } from "#tools/workflow-entry-point.js";

export function entryPointOf(
  definition: HarnessToolDefinition | undefined,
): WorkflowToolEntryPoint {
  const target = dispatchTargetOf(definition);
  if (target === undefined) return "execute";
  if (target.kind === "workflow-tool-call") return target.entryPoint;
  return "serve";
}

export function startsTasks(definition: HarnessToolDefinition | undefined): boolean {
  return entryPointOf(definition) !== "execute";
}

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
