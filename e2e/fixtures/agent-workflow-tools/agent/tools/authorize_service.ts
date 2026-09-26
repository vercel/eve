import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";
import { fixtureUrl } from "../lib/fake-service.ts";

export default defineWorkflowTool({
  description: "Exercise requester authorization inside a durable step.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute(ctx) {
    "use workflow";
    const { abortSignal, input } = await ctx.receive();
    return await authorizeService(ctx, input.service, abortSignal);
  },
});

async function authorizeService(
  ctx: WorkflowToolContext,
  service: string,
  signal: AbortSignal,
): Promise<string> {
  "use step";
  const fakeProvider = createFakeAuthProvider({ expiredToken: service === "EXPLICIT" });
  const { token } = await ctx.getToken(fakeProvider);
  const response = await fetch(fixtureUrl(`/fixture-service/${encodeURIComponent(service)}`), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status === 401) ctx.requireAuth(fakeProvider);
  if (!response.ok) throw new Error(`Fixture service returned ${response.status}`);
  return await response.text();
}
