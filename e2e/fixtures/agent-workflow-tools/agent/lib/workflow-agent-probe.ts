import { agent } from "eve/workflow";
import { z } from "zod";

export const workflowAgentProbeInputSchema = z.strictObject({
  kind: z.enum(["auth", "hitl"]),
});

export async function executeWorkflowAgentProbe(
  input: z.infer<typeof workflowAgentProbeInputSchema>,
  ctx: Parameters<typeof agent>[0],
): Promise<unknown> {
  return await agent(ctx, {
    key: `local-${input.kind}`,
    message: `Run the ${input.kind} probe.`,
    target: input.kind === "hitl" ? "workflow-hitl" : "workflow-auth",
  });
}
