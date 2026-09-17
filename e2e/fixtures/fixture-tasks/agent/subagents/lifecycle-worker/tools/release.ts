import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";
import { lifecycleGate } from "../../../lib/lifecycle-control.js";

type Input = { parentSessionId: string; key: string; marker: "B" };

async function execute(input: Input, ctx: WorkflowToolContext): Promise<string> {
  "use workflow";
  await lifecycleGate({ ...input, sessionId: ctx.session.id, turnId: ctx.session.turn.id });
  return "BOB-RELEASED";
}

const tool: WorkflowToolDefinition<Input, string> = defineWorkflowTool({
  description: "Acknowledge Bob's metered work and wait for the coordinator's release.",
  inputSchema: z.object({
    parentSessionId: z.string().min(1),
    key: z.string().uuid(),
    marker: z.literal("B"),
  }),
  execute,
});

export default tool;
