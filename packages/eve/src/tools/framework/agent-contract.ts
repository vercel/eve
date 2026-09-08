import { z } from "#compiled/zod/index.js";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_DESCRIPTION = [
  "Delegate a focused subtask to a copy of yourself, or continue or steer a previous delegation with `agentId`.",
  "Use it to isolate complex work or split a large task into independent pieces.",
  "Issue multiple `agent` calls in one response to run a small fixed set in parallel.",
  "A new child has fresh history and state but shares your tools and sandbox, so include essential context in `message` and give parallel writers non-overlapping scopes.",
].join(" ");

export const SUBAGENT_TOOL_INPUT_SCHEMA = z.strictObject({
  agentId: z
    .string()
    .nullable()
    .describe(
      "The id of an existing agent from the <agents> list or a task receipt. A message to a busy agent steers it: its previous task is cancelled and the updated work runs in the same child session. Omit this field (or pass null or an empty string) to start a new agent.",
    )
    .optional(),
  message: z
    .string()
    .describe(
      "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    ),
  outputSchema: z
    .looseObject({})
    .describe(
      "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The subagent must match a provided schema, and that structured output becomes the tool result.",
    )
    .optional(),
});

export const SUBAGENT_EXECUTION_SCHEMA = z.strictObject({
  model: z.string().min(1),
  reasoning: z
    .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .describe(
      "Choose reasoning effort for this task using the selected model's supported levels. Omit to retain the worker's authored reasoning setting.",
    )
    .optional(),
  maxCostUsd: z
    .number()
    .finite()
    .positive()
    .describe(
      "Optional child-session model cost ceiling in USD. Choose a budget appropriate to the assignment; it cannot raise inherited or authored limits and is not a reservation from a shared budget.",
    )
    .optional(),
});

export function createSubagentInputSchema(models: readonly string[]) {
  return SUBAGENT_TOOL_INPUT_SCHEMA.extend({
    execution: SUBAGENT_EXECUTION_SCHEMA.extend({
      model: z
        .enum(models)
        .describe(
          "Choose an allowed model appropriate to the task's complexity, quality requirements, latency and cost, using available instructions or skills. No automatic routing is performed.",
        ),
    })
      .describe(
        "Select model, reasoning effort and budget for a new delegation. Omit to use the worker's defaults. Do not supply when resuming with agentId; an existing child retains its configuration.",
      )
      .optional(),
  });
}
