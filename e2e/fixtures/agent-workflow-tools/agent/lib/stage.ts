import { sleep } from "workflow";

import { describePlan, hashPlan } from "./plan.ts";

/**
 * Plans a deploy, then lets it settle for a few seconds: long enough that the
 * model's next step always runs while the task is still working. Call it from
 * a workflow body.
 */
export async function stageDeploy(service: string): Promise<{ digest: string; plan: string }> {
  const plan = describePlan(service);
  const digest = await hashPlan(plan);
  await sleep("3s");
  return { digest, plan };
}
