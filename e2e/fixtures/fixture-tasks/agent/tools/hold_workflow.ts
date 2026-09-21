import { defineWorkflowTool, type WorkflowToolDefinition } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

type Input = { duration: "45s" };

async function execute({ duration }: Input): Promise<{ held: "45s" }> {
  "use workflow";
  await sleep(duration);
  return { held: duration };
}

const tool: WorkflowToolDefinition<Input, { held: "45s" }> = defineWorkflowTool({
  description: "Test-only durable foreground workflow hold.",
  inputSchema: z.object({ duration: z.literal("45s") }),
  execute,
});

export default tool;
