import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent, registerLocalSubagentExecutor } from "#execution/tools/subagent/local.js";
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
  "description" | "execution" | "kind" | "name" | "nodeId"
> & {
  readonly inputSchema?: ToolSchemaSource | null;
  readonly outputSchema?: ToolSchemaSource | null;
  readonly rootOnly?: boolean;
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
    description: describeSubagentExecution(tool.description, "blocking"),
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
    rootOnly: tool.rootOnly,
    runtimeAction,
    subagentKind: tool.kind === "remote" ? "remote" : "local",
    workflowCallable: tool.execution !== "background",
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
  if (tool.kind !== "remote") registerLocalSubagentExecutor(execute);
  return {
    description: describeSubagentExecution(definition.description, "background"),
    execute,
    execution: definition.execution,
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema) ?? undefined,
    rootOnly: tool.rootOnly,
    subagentKind: tool.kind === "remote" ? "remote" : "local",
    workflowCallable: false,
  };
}

function describeSubagentExecution(
  description: string | undefined,
  execution: "background" | "blocking",
): string {
  const behavior =
    execution === "background"
      ? "This call starts a background task and returns a task receipt immediately."
      : "This call waits for the subagent and returns its result.";
  return `${description ?? ""}\n\n${behavior}`;
}
