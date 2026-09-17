import { defineWorkflowTool, type WorkflowToolDefinition } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

type Input = { delay: "20s" };

async function execute({ delay }: Input): Promise<{ waited: "20s" }> {
  "use workflow";
  await sleep(delay);
  return { waited: delay };
}

const tool: WorkflowToolDefinition<Input, { waited: "20s" }> = defineWorkflowTool({
  description: "Wait before the deterministic approval sequence.",
  inputSchema: z.object({ delay: z.literal("20s") }),
  execute,
});

export default tool;
