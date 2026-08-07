import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Stable model-visible name for the root-only agent delegation tool.
 */
export const AGENT_TOOL_NAME = "agent";

/**
 * Model-facing instructions for the root-only agent delegation tool.
 */
export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a fresh copy of yourself.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "Each child has fresh history and state but shares your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
].join(" ");

/**
 * Whether one node receives the implicit built-in `agent` tool.
 *
 * Single source of truth for the injection predicate: node-step uses it to
 * decide whether to add the tool, and prompt bootstrap uses it to decide
 * whether agent-messaging instructions may reference the tool. The
 * `hasAuthoredAgentTool` leg matters because an authored tool named "agent"
 * shadows the framework tool — instructions must not advertise a tool the
 * model cannot call.
 */
export function isImplicitAgentToolAvailable(input: {
  readonly disabledFrameworkTools: readonly string[];
  readonly hasAuthoredAgentTool: boolean;
  /** Undefined when the caller prepares a turn without a graph node (never root). */
  readonly nodeId: string | undefined;
}): boolean {
  return (
    input.nodeId === ROOT_RUNTIME_AGENT_NODE_ID &&
    !input.disabledFrameworkTools.includes(AGENT_TOOL_NAME) &&
    !input.hasAuthoredAgentTool
  );
}

/**
 * Shared metadata for the root-only agent delegation tool.
 */
export const AGENT_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: AGENT_TOOL_DESCRIPTION,
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
  logicalPath: "eve:framework/agent",
  name: AGENT_TOOL_NAME,
  sourceId: "eve:agent-tool",
  sourceKind: "module",
};
