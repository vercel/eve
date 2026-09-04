import type { WorkflowToolContext } from "eve/tools";
import { z } from "zod";

export const workflowAgentProbeInputSchema = z.strictObject({
  kind: z.enum(["auth", "hitl"]),
});

export async function executeWorkflowAgentProbe(
  input: z.infer<typeof workflowAgentProbeInputSchema>,
  ctx: WorkflowToolContext,
): Promise<unknown> {
  return await ctx.agent({
    key: `local-${input.kind}`,
    message: `Run the ${input.kind} probe.`,
    target: input.kind === "hitl" ? "workflow-hitl" : "workflow-auth",
  });
}
