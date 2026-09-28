import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself, or continue a previous delegation with `agentId`.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but reuses your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
].join(" ");

export interface SubagentToolInput {
  agentId?: string | null;
  message: string;
}

export const SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<SubagentToolInput>({
  type: "object",
  properties: {
    agentId: {
      type: ["string", "null"],
      description:
        "The id of an existing agent from the <agents> list. Omit this field (or pass null or an empty string) to start a new agent.",
    },
    message: {
      type: "string",
      description:
        "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
