import { DEFAULT_EVALUATION_MODEL, evaluate } from "#ai/evaluate.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type {
  AgentRouterAutoOptions,
  AgentRouterExecuteInput,
} from "#execution/tools/agent-router.js";

/** Routes one task through the complete workflow agent metadata snapshot. */
export async function executeAgentRouterTool(
  input: AgentRouterExecuteInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  const target = await auto({
    abortSignal: ctx.abortSignal,
    agents: descriptions(ctx),
    instructions: input.routerOptions?.instructions,
    message: input.message,
    model: input.routerOptions?.model,
  });
  return ctx.agent(
    target,
    input.outputSchema === undefined
      ? { message: input.message }
      : { message: input.message, outputSchema: input.outputSchema },
  );
}

export async function auto({
  abortSignal,
  agents,
  instructions = "Which subagent should handle this task?",
  message,
  model = DEFAULT_EVALUATION_MODEL,
}: AgentRouterAutoOptions): Promise<string> {
  "use step";

  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("agentRouter auto requires a non-empty message.");
  }
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
    throw new Error("agentRouter auto requires an agent description map.");
  }
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    throw new Error("agentRouter auto requires non-empty instructions when provided.");
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("agentRouter auto requires a non-empty model ID when provided.");
  }
  const criteria = Object.fromEntries(
    Object.entries(agents).flatMap(([name, description]) => {
      if (typeof description !== "string") {
        throw new Error(`agentRouter auto requires a string description for agent "${name}".`);
      }
      const trimmed = description.trim();
      return trimmed.length === 0 ? [] : [[name, trimmed]];
    }),
  );
  const names = Object.keys(criteria);
  if (names.length === 0) {
    throw new Error("agentRouter requires at least one available agent with a description.");
  }
  if (names.length === 1) return names[0]!;

  const result = await evaluate({
    abortSignal,
    model,
    state: { message },
    questions: {
      route: {
        type: "choice",
        instructions,
        criteria,
      },
    },
  });
  return result.answers.route.choice;
}

function descriptions(ctx: WorkflowToolContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ctx.agents).map(([name, metadata]) => [name, metadata.description]),
  );
}
