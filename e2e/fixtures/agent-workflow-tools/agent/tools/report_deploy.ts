import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan, hashPlan } from "../lib/plan.ts";

/**
 * Background workflow tool: the model gets a receipt, intermediate yields are consumed,
 * and the return value reaches the parent in the terminal cohort report.
 */
export default defineWorkflowTool({
  description: "Plan a deploy in the background and report when it is ready.",
  execution: "background",
  inputSchema: z.strictObject({ service: z.string() }),
  async *execute({ service }) {
    "use workflow";

    const plan = describePlan(service);
    yield { plan };
    yield { message: "WORKFLOW-REPORT-PROGRESS", plan };
    const digest = await hashPlan(plan);
    return { digest, plan, result: "WORKFLOW-REPORT-COMPLETE" };
  },
});
