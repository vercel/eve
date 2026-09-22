import type { WorkflowToolContext } from "eve/tools";
import { z } from "zod";

export const workflowAgentProbeInputSchema = z.strictObject({
  kind: z.enum(["auth", "hitl"]),
});

export async function executeWorkflowAgentProbe(
  input: z.infer<typeof workflowAgentProbeInputSchema>,
  ctx: WorkflowToolContext,
): Promise<unknown> {
  return await ctx.agent(input.kind === "hitl" ? "workflow-hitl" : "workflow-auth", {
    message: `Run the ${input.kind} probe.`,
  });
}
