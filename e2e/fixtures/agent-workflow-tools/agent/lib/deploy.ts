import type { WorkflowToolContext } from "eve/tools";
import { sleep } from "workflow";

import { describePlan, hashPlan } from "./plan.ts";

export async function deployService({ service }: { service: string }, ctx: WorkflowToolContext) {
  "use workflow";

  const plan = describePlan(service);
  const digest = await hashPlan(plan);
  await sleep("50ms");
  return { digest, plan, tool: ctx.toolName };
}
