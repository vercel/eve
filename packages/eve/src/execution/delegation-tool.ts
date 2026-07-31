import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

/** Converts a serializable delegation descriptor into a live harness tool. */
export function createHarnessDelegationToolDefinition(
  tool: PreparedRuntimeDelegationTool,
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
    outputSchema: toOutputSchema(tool.outputSchema),
    runtimeAction,
  };
}
