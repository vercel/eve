import type { WorkflowToolContext } from "eve/tools";
import { sleep } from "workflow";

import { describePlan, hashPlan } from "@/agent/lib/plan.ts";

export async function deployService(ctx: WorkflowToolContext<{ service: string }>) {
  "use workflow";

  const { input } = await ctx.receive();
  const plan = describePlan(input.service);
  const digest = await hashPlan(plan);
  await sleep("50ms");
  return { digest, plan, tool: ctx.toolName };
}
