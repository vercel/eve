import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

type Input = { target: "tool-hidden" | "disabled-hidden" };
type Output = {
  description: string;
  result: string | null;
};

async function execute({ target }: Input, ctx: WorkflowToolContext) {
  "use workflow";

  const description = ctx.agents[target]?.description;
  if (description === undefined) {
    throw new Error(`Missing workflow metadata for internal subagent ${target}.`);
  }
  const response = await ctx.agent(target).send("Return your fixed marker.");
  const { message } = await response.result();
  return { description, result: message ?? null };
}

const tool: WorkflowToolDefinition<Input, Output> = defineWorkflowTool({
  description: "Invoke an internal specialist selected by the caller.",
  inputSchema: z.object({
    target: z.enum(["tool-hidden", "disabled-hidden"]),
  }),
  execute,
});

export default tool;
