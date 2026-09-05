import { defineWorkflowTool, type WorkflowToolContext, type ToolAuthProvider } from "eve/tools";
import { ConnectionAuthorizationRequiredError } from "eve/connections";
import { z } from "zod";

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
  const provider: ToolAuthProvider = {
    principalType: "user",
    async getToken() {
      if (service === "EXPLICIT") return { token: "expired-fixture-token" };
      throw new ConnectionAuthorizationRequiredError("workflow-step");
    },
    async startAuthorization({ principal, callbackUrl }) {
      if (principal.type !== "user") throw new Error("Expected a requester");
      const url = new URL(callbackUrl);
      url.searchParams.set("code", principal.id);
      return { challenge: { url: url.href }, resume: { user: principal.id } };
    },
    async completeAuthorization({ principal, callback, resume }) {
      if (
        principal.type !== "user" ||
        callback.params.code !== principal.id ||
        (resume as { user: string }).user !== principal.id
      ) {
        throw new Error("Authorization did not match the workflow requester");
      }
      return { token: "authorized-fixture-token" };
    },
  };
  const { token } = await ctx.getToken(provider);
  if (token === "expired-fixture-token" || service === "REJECTED") ctx.requireAuth(provider);
  return "WORKFLOW-STEP-AUTH:authorized";
}
