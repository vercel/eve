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
