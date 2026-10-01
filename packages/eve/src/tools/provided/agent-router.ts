import type { JsonValue } from "#shared/json.js";
import {
  AGENT_ROUTER_INPUT_SCHEMA,
  AGENT_ROUTER_TOOL_DESCRIPTION,
  runAgentRouterTask,
  type AgentRouterInput,
} from "#execution/tools/agent-router.js";
import { defineWorkflowTool, type WorkflowTaskToolDefinition } from "#tools/workflow-definition.js";
import { markProvidedTool } from "#tools/provided/provided-tool.js";

export type { AgentRouterInput };

export type AgentRouterTool = WorkflowTaskToolDefinition<AgentRouterInput, JsonValue>;

/**
 * Defines a workflow tool that uses JEV to route a task across all available
 * agent targets. Each call runs as a task.
 */
export function agentRouter(): AgentRouterTool {
  const tool = defineWorkflowTool({
    availableInSubagents: false,
    description: AGENT_ROUTER_TOOL_DESCRIPTION,
    inputSchema: AGENT_ROUTER_INPUT_SCHEMA,
    task: runAgentRouterTask,
  });
  markProvidedTool(tool);
  return tool;
}
