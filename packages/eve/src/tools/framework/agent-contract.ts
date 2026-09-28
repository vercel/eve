import type { AgentToolInput } from "#runtime/subagents/workflow.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but reuses your tools and sandbox, so give parallel writers non-overlapping scopes.",
].join(" ");

export const SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<AgentToolInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The message to send to the agent, with everything it needs to do the work.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
