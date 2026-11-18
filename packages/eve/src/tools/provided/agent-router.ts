import type { JsonValue } from "#shared/json.js";
import {
  AGENT_ROUTER_INPUT_SCHEMA,
  AGENT_ROUTER_TOOL_DESCRIPTION,
  runAgentRouterTask,
  type AgentRouterInput,
} from "#execution/tools/agent-router.js";
import { defineWorkflowTool, type WorkflowTaskToolDefinition } from "#tools/workflow-definition.js";

export type { AgentRouterInput };

/**
 * The workflow tool {@link agentRouter} returns, which routes a task to the best available subagent.
 */
export type AgentRouterTool = WorkflowTaskToolDefinition<AgentRouterInput, JsonValue>;

/**
 * Defines a workflow tool that uses JEV to route a task across all available
 * agent targets. Each call runs as a task.
 */
export function agentRouter(): AgentRouterTool {
  return frameworkTool(
    defineWorkflowTool({
      availableInSubagents: false,
      description: AGENT_ROUTER_TOOL_DESCRIPTION,
      inputSchema: AGENT_ROUTER_INPUT_SCHEMA,
      task: runAgentRouterTask,
    }),
  );
}
import { frameworkTool } from "./framework-tool.js";
