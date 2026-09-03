import { defineTool } from "eve/tools";
import { z } from "zod";

import { describePlan, hashPlan } from "../lib/plan.ts";

/**
 * Background workflow tool: the model gets a receipt, `postMessage` delivers a
 * progress note, and the agent is woken with the return value.
 */
export default defineTool({
  description: "Plan a deploy in the background and report when it is ready.",
  execution: "background",
  inputSchema: z.strictObject({ service: z.string() }),
  async *execute({ service }, _ctx, task) {
    "use workflow";

    const plan = describePlan(service);
    yield { plan };
    yield task.postMessage(`Deploy ${task.taskId}: WORKFLOW-REPORT-PROGRESS ${plan}`);
    const digest = await hashPlan(plan);
    return { digest, plan, result: "WORKFLOW-REPORT-COMPLETE" };
  },
});
