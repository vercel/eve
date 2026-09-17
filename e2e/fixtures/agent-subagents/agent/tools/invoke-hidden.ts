import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

type Input = { target: "tool-hidden" | "disabled-hidden" };

async function execute({ target }: Input, ctx: WorkflowToolContext) {
  "use workflow";

  return ctx.agent(target, { message: "Return your fixed marker." });
}

const tool: WorkflowToolDefinition<
  Input,
  Awaited<ReturnType<WorkflowToolContext["agent"]>>
> = defineWorkflowTool({
  description: "Invoke an internal specialist selected by the caller.",
  inputSchema: z.object({
    target: z.enum(["tool-hidden", "disabled-hidden"]),
  }),
  execute,
});

export default tool;
