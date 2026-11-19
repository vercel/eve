import { defineDynamic, defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan, hashPlan } from "../lib/plan.ts";

/**
 * A top-level const, so the build hoists and compiles its inline workflow body; the resolver
 * below only decides whether to offer it.
 */
const dynamicDeploy = defineWorkflowTool({
  description: "Deploy a service through a workflow tool resolved for the session.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const plan = describePlan(service);
    const digest = await hashPlan(plan);
    return { digest, plan, tool: ctx.toolName };
  },
});

/** A workflow tool the session's resolver returns, rather than a static tool module. */
export default defineDynamic(() => dynamicDeploy);
