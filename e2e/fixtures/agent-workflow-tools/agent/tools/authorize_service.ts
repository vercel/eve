import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";
import { fakeServiceUrl } from "../lib/fake-service.ts";

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
  const response = await fetch(fakeServiceUrl(service), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(fakeProvider);
  if (!response.ok) throw new Error(`Fixture service returned ${response.status}`);
  return await response.text();
}
