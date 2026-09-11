import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";
import { lifecycleGate } from "../lib/lifecycle-control.js";

async function execute({ key }: { key: string }, ctx: WorkflowToolContext): Promise<string> {
  "use workflow";
  await lifecycleGate(
    {
      key,
      parentSessionId: ctx.session.id,
      marker: "parent",
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    },
    ctx.abortSignal,
  );
  return "PARENT-RELEASED";
}

const tool: WorkflowToolDefinition<{ key: string }, string> = defineWorkflowTool({
  description: "Keep Alice's unrelated parent turn active until its session cancellation.",
  inputSchema: z.object({ key: z.string().uuid() }),
  execute,
});

export default tool;
