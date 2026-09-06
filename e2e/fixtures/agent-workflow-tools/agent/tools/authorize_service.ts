import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";

export default defineWorkflowTool({
  description: "Exercise requester authorization inside a durable step.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    return await authorizeService(ctx, service);
  },
});

async function authorizeService(ctx: WorkflowToolContext, service: string): Promise<string> {
  "use step";
  const fakeProvider = createFakeAuthProvider({ expiredToken: service === "EXPLICIT" });
  const { token } = await ctx.getToken(fakeProvider);
  if (token === "expired-fixture-token" || service === "REJECTED") ctx.requireAuth(fakeProvider);
  return "WORKFLOW-STEP-AUTH:authorized";
}
