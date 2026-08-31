import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent } from "#execution/tools/subagent/local.js";
import { defineRemoteSubagent } from "#execution/tools/subagent/remote.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import {
  UNSPECIFIED_INPUT_SCHEMA,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";

type HarnessDelegationTool = Pick<
  PreparedRuntimeDelegationTool,
  "behavior" | "description" | "kind" | "name" | "nodeId"
> & {
  readonly inputSchema?: ToolSchemaSource | null;
  readonly outputSchema?: ToolSchemaSource | null;
};

export function createHarnessDelegationToolDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  return {
    behavior: tool.behavior,
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
  };
}

export function createBackgroundSubagentHarnessDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const definition =
    tool.kind === "remote"
      ? defineRemoteSubagent({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        })
      : defineSubagent({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        });
  const execute = createToolExecuteWithAuth({
    execute: definition.execute,
    execution: definition.execution,
    scope: tool.name,
  });
  return {
    behavior: tool.behavior,
    description: definition.description,
    execute,
    execution: definition.execution,
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema) ?? undefined,
  };
}
