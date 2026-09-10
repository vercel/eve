import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";

const auth = defineInteractiveAuthorization<{ marker: string }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("code-mode-auth");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "fixture-ok");
    return {
      challenge: { displayName: "Code Mode Auth", url: url.href },
      resume: { marker: "saved-challenge" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "fixture-ok" || resume?.marker !== "saved-challenge") {
      throw new Error("Code mode lost its authorization continuation.");
    }
    return { token: "code-mode-fixture-token" };
  },
});

export default defineTool({
  description: "Authorize a nested code-mode call using a fixture callback.",
  inputSchema: { type: "object" },
  async execute(_input, ctx) {
    const result = await ctx.getToken(auth, { authKey: "code-mode-auth" });
    return {
      authorized: result.token === "code-mode-fixture-token",
      actor: ctx.session.auth.current?.principalId,
    };
  },
});
