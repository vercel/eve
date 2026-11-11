import { defineDynamic, defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";

import { describePlan, hashPlan } from "@/agent/lib/plan.ts";

/** Top-level, so the build compiles it: the resolver below only passes it by reference. */
async function deployDynamically({ service }: { service: string }, ctx: WorkflowToolContext) {
  "use workflow";

  const plan = describePlan(service);
  const digest = await hashPlan(plan);
  return { digest, plan, tool: ctx.toolName };
}

/** A workflow tool the session's resolver returns, rather than a static tool module. */
export default defineDynamic(() =>
  defineWorkflowTool({
    description: "Deploy a service through a workflow tool resolved for the session.",
    inputSchema: z.strictObject({ service: z.string() }),
    execute: deployDynamically,
  }),
);
