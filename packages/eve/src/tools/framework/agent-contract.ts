import type { AgentToolInput } from "#runtime/subagents/workflow.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate an independent, self-contained subtask to a fresh copy of yourself sharing your tools and sandbox.",
  "Prefer doing routine file reads, targeted edits, and test runs directly; delegate only when isolated exploration or genuinely independent work saves effort.",
  "Specify the goal, expected output, and whether it may edit files (if so, give it a non-overlapping scope).",
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
