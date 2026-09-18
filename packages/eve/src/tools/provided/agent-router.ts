import type { JsonValue } from "#shared/json.js";
import {
  AGENT_ROUTER_INPUT_SCHEMA,
  AGENT_ROUTER_TOOL_DESCRIPTION,
  executeAgentRouterTool,
  type AgentRouterInput,
} from "#execution/tools/agent-router.js";
import {
  defineWorkflowTool,
  type BlockingWorkflowToolDefinition,
} from "#tools/workflow-definition.js";

export type { AgentRouterInput };

export type AgentRouterTool = BlockingWorkflowToolDefinition<AgentRouterInput, JsonValue>;

/** Defines a workflow tool that uses JEV to route a task across all available agent targets. */
export function agentRouter(): AgentRouterTool {
  return defineWorkflowTool({
    description: AGENT_ROUTER_TOOL_DESCRIPTION,
    execute: executeAgentRouterTool,
    inputSchema: AGENT_ROUTER_INPUT_SCHEMA,
  });
}
