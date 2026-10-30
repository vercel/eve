import type { WorkflowToolContext } from "eve/tools";
import { z } from "zod";

import { replyFrom } from "./agent-reply.ts";

export const workflowAgentProbeInputSchema = z.strictObject({
  kind: z.enum(["auth", "hitl"]),
});

export async function executeWorkflowAgentProbe(
  input: z.infer<typeof workflowAgentProbeInputSchema>,
  ctx: WorkflowToolContext,
): Promise<string | null> {
  const name = input.kind === "hitl" ? "workflow-hitl" : "workflow-auth";
  return await replyFrom(ctx, name, `Run the ${input.kind} probe.`);
}
