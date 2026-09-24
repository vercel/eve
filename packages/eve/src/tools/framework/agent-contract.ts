import type { JsonObject } from "#shared/json.js";
import { defineJsonSchema } from "#tools/schema.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself, or continue or steer a previous delegation with `agentId`.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but reuses your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
].join(" ");

export interface SubagentToolInput {
  agentId?: string | null;
  message: string;
  model?: string;
  outputSchema?: JsonObject;
}

const SUBAGENT_TOOL_INPUT_PROPERTIES = {
  agentId: {
    type: ["string", "null"],
    description:
      "The id of an existing agent from the <agents> list or a task receipt. A message to a busy agent steers it: its previous task is cancelled and the updated work runs in the same child session. Omit this field (or pass null or an empty string) to start a new agent.",
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
} satisfies JsonObject;

export const SUBAGENT_TOOL_INPUT_SCHEMA = createSubagentToolInputSchema(undefined);

/**
 * Subagent tool input. A subagent whose `agent.ts` lists several models also
 * accepts a `model` choice; the first listed model is the default.
 */
export function createSubagentToolInputSchema(modelChoices: readonly string[] | undefined) {
  return defineJsonSchema<SubagentToolInput>({
    type: "object",
    properties:
      modelChoices === undefined
        ? SUBAGENT_TOOL_INPUT_PROPERTIES
        : {
            ...SUBAGENT_TOOL_INPUT_PROPERTIES,
            model: {
              type: "string",
              enum: [...modelChoices],
              default: modelChoices[0]!,
              description: `Model for a new agent. Defaults to ${modelChoices[0]}. Omit this field when continuing an agent with \`agentId\`.`,
            },
          },
    required: ["message"],
    additionalProperties: false,
  });
}
