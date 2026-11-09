import { createPreparedWorkflowToolHarnessDefinition } from "#execution/tools/workflow/harness-definition.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { CodeAgent } from "#runtime/sessions/session-agent.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import { createPreparedRuntimeSubagentTool } from "#runtime/subagents/registry.js";
import {
  AGENT_TOOL_DESCRIPTION,
  AGENT_TOOL_NAME,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { serializeInputSchema } from "#tools/schema.js";
import type { Definition } from "./definition.js";
import { toolEntries } from "./tools.js";

// Delegation for an agent defined in code: a tool per subagent, and the `agent` tool that starts
// a copy of the root. Each is the tool a compiled agent's file would make, under that file's id,
// so its calls dispatch through the same framework `serve` body.

const CODE_SOURCE_ID = "code:agent";

/** The node a code agent's subagent `name` is, as `subagents/<name>/` would be in a graph. */
export function subagentNodeId(name: string): string {
  return `subagents/${name}`;
}

/**
 * A subagent, as `subagents/<name>/agent.ts` would declare it: a tool the model delegates with,
 * and the agent it starts (`resources.subagent`), which needs a description for the model.
 */
export function subagentDefinitionOf(name: string, agent: CodeAgent): Definition {
  const reservation = eveNamespaceReservation(name);
  if (reservation !== undefined) {
    throw new Error(`Subagent "${name}" uses a reserved name. ${reservation}; rename it.`);
  }
  const { description } = agent;
  if (description === undefined || description.trim() === "") {
    throw new Error(
      `Subagent "${name}" needs a description, which the parent's model reads to delegate to it: agent({ description, ... }).`,
    );
  }
  const logicalPath = `subagents/${name}/agent.ts`;
  const tool = createPreparedWorkflowToolHarnessDefinition(
    createPreparedRuntimeSubagentTool({
      description,
      kind: "subagent",
      logicalPath,
      name,
      nodeId: subagentNodeId(name),
      sourceId: CODE_SOURCE_ID,
      sourceKind: "module",
    }),
  );
  const id = `subagent:${subagentNodeId(name)}`;
  return {
    contribute: () => ({ tools: () => ({ entries: toolEntries([tool], id) }) }),
    id,
    label: logicalPath,
    resources: { subagent: { agent, description, name } },
  };
}

/** The `agent` tool `tools/agent.ts` gives a compiled root: a copy of the session's own agent. */
const SELF_AGENT_TOOL: PreparedRuntimeTool = {
  behavior: {
    availability: ["root-session"],
    handling: {
      kind: "dispatch",
      target: {
        kind: "self-agent-call",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        subagentName: AGENT_TOOL_NAME,
      },
    },
  },
  description: AGENT_TOOL_DESCRIPTION,
  inputSchema: serializeInputSchema(SUBAGENT_TOOL_INPUT_SCHEMA),
  kind: "authored-tool",
  logicalPath: "tools/agent.ts",
  name: AGENT_TOOL_NAME,
  owner: { feature: "eve:root-defaults", kind: "framework" },
  rootOnly: true,
  sourceId: CODE_SOURCE_ID,
};

/** The `agent` tool, under the id its file would take. Root sessions only, as for a file agent. */
export const selfAgentToolDefinition: Definition = {
  contribute: () => ({
    tools: () => ({
      entries: toolEntries(
        [createPreparedWorkflowToolHarnessDefinition(SELF_AGENT_TOOL)],
        "tool::agent",
      ),
    }),
  }),
  id: "tool::agent",
  label: "tools/agent.ts",
};
