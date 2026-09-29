import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const CODE = "direct-release-code";
const NAME = "direct-release-authorization";
const authorization = defineInteractiveAuthorization<{ marker: "direct" }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError(NAME);
  },
  async startAuthorization() {
    return {
      challenge: { displayName: "Direct release checklist sign-in", userCode: CODE },
      resume: { marker: "direct" as const },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== CODE || resume?.marker !== "direct") {
      throw new Error("Direct release checklist authorization failed.");
    }
    return { token: "direct-release-token" };
  },
});

export default defineTool({
  description: "Authorize Alice's release checklist in the remote agent.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const result = await ctx.getToken(authorization, {
      authKey: NAME,
      displayName: "Direct release checklist sign-in",
    });
    if (result.token !== "direct-release-token") throw new Error("Unexpected authorization token.");
    return "Alice authorized the release checklist.";
  },
});
