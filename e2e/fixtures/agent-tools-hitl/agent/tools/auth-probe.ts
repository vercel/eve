import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const TOKEN = "interactive-auth-token-H6P3";

const auth = defineInteractiveAuthorization<{ marker: string }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("auth-probe");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "fixture-ok");
    return {
      challenge: { displayName: "Fixture Auth", url: url.href },
      resume: { marker: "fixture-resume" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "fixture-ok" || resume?.marker !== "fixture-resume") {
      throw new Error("Fixture authorization state mismatch.");
    }
    return { token: TOKEN };
  },
});

export default defineTool({
  description: "Interactive authorization lifecycle probe. Call only when explicitly requested.",
  inputSchema: z.object({ marker: z.string() }),
  async execute(input, ctx) {
    const token = await ctx.getToken(auth, { authKey: "auth-probe", displayName: "Fixture Auth" });
    return {
      actor: ctx.session.auth.current?.principalId ?? "none",
      marker: input.marker,
      token: token.token,
    };
  },
});
