import type { AgentToolInput } from "#runtime/subagents/workflow.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a fresh copy of yourself sharing your tools and sandbox.",
  "Start independent calls together before waiting, give parallel writers non-overlapping scopes, and specify the goal, expected output, and whether it may edit files.",
].join(" ");

export const SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<AgentToolInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "Self-contained instructions for the agent.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
