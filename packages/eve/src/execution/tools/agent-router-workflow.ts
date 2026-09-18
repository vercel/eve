import { evaluate } from "#ai/evaluate.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { AgentRouterInput } from "#execution/tools/agent-router.js";

/** Routes one task through the complete workflow agent metadata snapshot. */
export async function executeAgentRouterTool(
  input: AgentRouterInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  const target = await chooseTarget(input.message, descriptions(ctx), ctx.abortSignal);
  return ctx.agent(
    target,
    input.outputSchema === undefined
      ? { message: input.message }
      : { message: input.message, outputSchema: input.outputSchema },
  );
}

async function chooseTarget(
  message: string,
  criteria: Record<string, string>,
  abortSignal: AbortSignal,
): Promise<string> {
  "use step";

  const names = Object.keys(criteria);
  if (names.length === 0) {
    throw new Error("agentRouter requires at least one available agent target.");
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
    Object.entries(ctx.agents).map(([name, metadata]) => [name, metadata.description]),
  );
}
