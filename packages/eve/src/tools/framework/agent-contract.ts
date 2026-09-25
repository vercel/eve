import type { JsonObject } from "#shared/json.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but reuses your tools and sandbox, so give parallel writers non-overlapping scopes.",
].join(" ");

/**
 * Input of every agent tool. Its harness definition adds `taskId`, with
 * which a call sends to an agent task this tool started.
 */
export interface SubagentToolInput {
  message: string;
  outputSchema?: JsonObject;
}

export const SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<SubagentToolInput>({
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    },
    outputSchema: {
      type: "object",
      description:
        "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The subagent must match a provided schema, and that structured output becomes the task's result. With taskId, a schema replaces the one the task's current work was given.",
    },
  },
  required: ["message"],
  additionalProperties: false,
});
