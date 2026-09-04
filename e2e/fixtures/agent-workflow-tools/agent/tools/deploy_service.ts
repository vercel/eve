import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { describePlan, hashPlan } from "../lib/plan.ts";

/**
 * Waiting workflow tool: the turn parks while the run hashes the plan and
 * sleeps, then resumes with the return value as the tool result.
 */
export default defineWorkflowTool({
  description: "Deploy a service after planning it durably.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    const plan = describePlan(service);
    const digest = await hashPlan(plan);
    await sleep("50ms");
    return { digest, plan, tool: ctx.toolName };
  },
});
