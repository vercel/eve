import { z } from "#compiled/zod/index.js";
import type { JsonObject } from "#shared/json.js";

export { auto, executeAgentRouterTool } from "#execution/tools/agent-router-workflow.js";

export const AGENT_ROUTER_TOOL_DESCRIPTION =
  "Route a task to the best available subagent based on each subagent's declared description.";

export interface AgentRouterOptions {
  /** Instructions used to select an agent. */
  readonly instructions?: string;
  /** Evaluation model ID. Defaults to TypeSafe Jev. */
  readonly model?: string;
}

export interface AgentRouterAutoOptions extends AgentRouterOptions {
  readonly abortSignal?: AbortSignal;
  readonly agents: Readonly<Record<string, string>>;
  readonly message: string;
}

export interface AgentRouterInput {
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export interface AgentRouterExecuteInput extends AgentRouterInput {
  readonly routerOptions?: AgentRouterOptions;
}

export const AGENT_ROUTER_INPUT_SCHEMA: z.ZodType<AgentRouterInput> = z.strictObject({
  message: z.string().min(1).describe("The complete task to send to the selected agent."),
  outputSchema: (
    z
      .looseObject({})
      .describe(
        "Only provide a non-empty JSON Schema when the caller explicitly requests structured output; otherwise omit this field. The selected agent must match a provided schema, and that structured output becomes the tool result.",
      ) as z.ZodType<JsonObject>
  ).optional(),
});

export function createAgentRouterInputSchema(
  options: AgentRouterOptions,
): z.ZodType<AgentRouterExecuteInput> {
  return AGENT_ROUTER_INPUT_SCHEMA.transform((input) => ({
    ...input,
    routerOptions: options,
  }));
}
