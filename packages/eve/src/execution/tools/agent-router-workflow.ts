import { evaluate } from "#ai/evaluate.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { AgentRouterInput } from "#execution/tools/agent-router.js";

/** Routes one task through the complete workflow agent metadata snapshot. */
export async function executeAgentRouterTool(
  ctx: WorkflowToolContext<AgentRouterInput, JsonValue>,
): Promise<JsonValue> {
  "use workflow";

  const { abortSignal, input } = await ctx.receive();
  const target = await chooseTarget(input.message, descriptions(ctx), abortSignal);
  return ctx.agent(target, { message: input.message });
}

async function chooseTarget(
  message: string,
  criteria: Record<string, string>,
  abortSignal: AbortSignal,
): Promise<string> {
  "use step";

  const names = Object.keys(criteria);
  if (names.length === 0) {
    throw new Error("agentRouter requires at least one available agent with a description.");
  }
  if (names.length === 1) return names[0]!;

  const result = await evaluate({
    abortSignal,
    state: { message },
    questions: {
      route: {
        type: "choice",
        instructions: "Which subagent should handle this task?",
        criteria,
      },
    },
  });
  return result.answers.route.choice;
}

function descriptions(ctx: WorkflowToolContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ctx.agents).flatMap(([name, metadata]) => {
      const description = metadata.description.trim();
      return description.length === 0 ? [] : [[name, description]];
    }),
  );
}
