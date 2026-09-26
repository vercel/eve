import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

type Input = { target: "tool-hidden" | "disabled-hidden" };
type Output = {
  description: string;
  result: Awaited<ReturnType<WorkflowToolContext["agent"]>>;
};

async function execute(ctx: WorkflowToolContext<Input>) {
  "use workflow";

  const { target } = (await ctx.receive()).input;
  const description = ctx.agents[target]?.description;
  if (description === undefined) {
    throw new Error(`Missing workflow metadata for internal subagent ${target}.`);
  }
  const result = await ctx.agent(target, { message: "Return your fixed marker." });
  return { description, result };
}

const tool: WorkflowToolDefinition<Input, Output> = defineWorkflowTool({
  description: "Invoke an internal specialist selected by the caller.",
  inputSchema: z.object({
    target: z.enum(["tool-hidden", "disabled-hidden"]),
  }),
  execute,
});

export default tool;
