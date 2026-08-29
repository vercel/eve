import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { registerSubagentTaskLauncher } from "#harness/background-tools.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent, registerLocalSubagentExecutor } from "#execution/tools/subagent/local.js";
import { defineRemoteSubagent } from "#execution/tools/subagent/remote.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import { deriveTaskId } from "#tasks/task-id.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import {
  UNSPECIFIED_INPUT_SCHEMA,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";

type HarnessDelegationTool = Pick<
  PreparedRuntimeDelegationTool,
  "description" | "kind" | "name" | "nodeId"
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
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
    rootOnly: tool.rootOnly,
    runtimeAction,
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
  registerSubagentTaskLauncher(execute, {
    mode: tool.kind === "remote" ? "remote" : "local",
    preview({ callId, session, toolInput, turnId }) {
      const parsed = SUBAGENT_TOOL_INPUT_SCHEMA.parse(toolInput);
      const requestedAgentId =
        typeof parsed.agentId === "string" && parsed.agentId.trim() !== ""
          ? parsed.agentId
          : undefined;
      const existingAgent = getAgentHandleStore(session.state)?.handles.some(
        (handle) => handle.identity.id === requestedAgentId,
      );
      const agentId =
        requestedAgentId === undefined || requestedAgentId === "" || existingAgent !== true
          ? mintStartOperation({
              callId,
              name: tool.name,
              nodeId: tool.nodeId,
              parentSessionId: session.sessionId,
              parentTurnId: turnId,
            }).identity.id
          : requestedAgentId;
      return {
        agentId,
        status: "working",
        taskId: deriveTaskId({ callId, parentSessionId: session.sessionId, parentTurnId: turnId }),
      };
    },
  });
  return {
    description: definition.description,
    execute,
    execution: definition.execution,
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema) ?? undefined,
    rootOnly: tool.rootOnly,
  };
}
