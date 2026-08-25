import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";

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
 * Framework `agent` tool: the root-only self-delegation tool. It has no
 * executor — the harness dispatches the delegated child session.
 */
export default markHarnessOwnedToolDefinition({
  description: AGENT_TOOL_DESCRIPTION,
  inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
});
