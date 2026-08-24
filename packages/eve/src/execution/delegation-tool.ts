import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  createLocalSubagentExecute,
  registerLocalSubagentExecutor,
} from "#kernel/subagent/local.js";
import { createRemoteSubagentExecute } from "#kernel/subagent/remote.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#kernel/subagent/task-receipt.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import {
  UNSPECIFIED_INPUT_SCHEMA,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#shared/tool-schema.js";

type HarnessDelegationTool = Pick<
  PreparedRuntimeDelegationTool,
  "description" | "kind" | "name" | "nodeId"
> & {
  readonly inputSchema?: ToolSchemaSource | null;
  readonly outputSchema?: ToolSchemaSource | null;
};

export function createHarnessDelegationToolDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const runtimeAction: HarnessToolDefinition["runtimeAction"] =
    tool.kind === "remote"
      ? {
          kind: "remote-agent-call",
          nodeId: tool.nodeId,
          remoteAgentName: tool.name,
          subagentName: tool.name,
        }
      : {
          kind: "subagent-call",
          nodeId: tool.nodeId,
          subagentName: tool.name,
        };

  return {
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
    runtimeAction,
    workflowCallable: true,
  };
}

export function createBackgroundSubagentHarnessDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const rawExecute =
    tool.kind === "remote"
      ? createRemoteSubagentExecute({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        })
      : createLocalSubagentExecute({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        });
  const execute = createToolExecuteWithAuth({
    execute: rawExecute,
    execution: "background",
    scope: tool.name,
  });
  if (tool.kind !== "remote") registerLocalSubagentExecutor(execute);
  return {
    description: tool.description ?? "",
    execute,
    execution: "background",
    inputSchema: toInputSchema(PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA) ?? undefined,
    workflowCallable: true,
  };
}
