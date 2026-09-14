import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const auth = defineInteractiveAuthorization<{ marker: string }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("workflow-auth");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "workflow-auth-ok");
    return {
      challenge: { displayName: "Workflow Auth", url: url.href },
      resume: { marker: "workflow-auth-resume" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "workflow-auth-ok" || resume?.marker !== "workflow-auth-resume") {
      throw new Error("Workflow authorization state mismatch.");
    }
    return { token: "workflow-auth-token" };
  },
});

export default defineTool({
  description: "Return a deterministic marker after interactive authorization.",
  inputSchema: z.strictObject({ marker: z.string() }),
  async execute({ marker }, ctx) {
    await ctx.getToken(auth, { authKey: "workflow-auth", displayName: "Workflow Auth" });
    return `WORKFLOW-AUTH:${marker}`;
  },
});
