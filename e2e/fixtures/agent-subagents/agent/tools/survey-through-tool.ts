import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

type Input = Record<string, never>;
type Output = { survey: string | null };

async function execute(_input: Input, ctx: WorkflowToolContext) {
  "use workflow";

  const response = await ctx
    .agent("survey-worker")
    .send("Please count the tide survey stations for Alice.");
  const { message } = await response.result();
  return { survey: message ?? null };
}

/** Runs Alice's survey through a `ctx.agent` session with survey-worker and returns its count. */
const tool: WorkflowToolDefinition<Input, Output> = defineWorkflowTool({
  description:
    "Test fixture: counts Alice's tide survey stations through survey-worker. Call it only for SURVEY-TOOL directives.",
  inputSchema: z.object({}),
  execute,
});

export default tool;
