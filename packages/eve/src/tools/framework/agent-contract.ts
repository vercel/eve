import type { JsonObject } from "#shared/json.js";
import { AGENT_ID_PARAMETER_DESCRIPTION, BACKGROUND_PARAMETER_DESCRIPTION } from "#tasks/render.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself, or give an idle previous delegation more work with `agentId`.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but reuses your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
].join(" ");

export interface SubagentToolInput {
  agentId?: string | null;
  message: string;
  outputSchema?: JsonObject;
}

const SUBAGENT_TOOL_INPUT_PROPERTIES: JsonObject = {
  agentId: {
    type: ["string", "null"],
    description: AGENT_ID_PARAMETER_DESCRIPTION,
  },
  message: {
    type: "string",
    description:
      "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
  },
  outputSchema: {
    type: "object",
    description:
      "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The subagent must match a provided schema, and that structured output becomes the tool result.",
  },
};

export const SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<SubagentToolInput>({
  type: "object",
  properties: SUBAGENT_TOOL_INPUT_PROPERTIES,
  required: ["message"],
  additionalProperties: false,
});

/** Agent tool input where the model may run a call in the background: interactive root sessions only. */
export const BACKGROUND_SUBAGENT_TOOL_INPUT_SCHEMA = defineJsonSchema<
  SubagentToolInput & { background?: boolean }
>({
  type: "object",
  properties: {
    ...SUBAGENT_TOOL_INPUT_PROPERTIES,
    background: { type: "boolean", description: BACKGROUND_PARAMETER_DESCRIPTION },
  },
  required: ["message"],
  additionalProperties: false,
});
