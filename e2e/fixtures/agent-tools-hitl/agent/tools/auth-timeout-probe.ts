import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const auth = defineInteractiveAuthorization({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("auth-timeout-probe");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "too-late");
    return {
      challenge: {
        displayName: "Expiring Fixture Auth",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        url: url.href,
      },
    };
  },
  async completeAuthorization() {
    return { token: "late-token-must-not-run" };
  },
});

export default defineTool({
  description: "Expiring authorization probe. Call only when explicitly requested.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const token = await ctx.getToken(auth, { authKey: "auth-timeout-probe" });
    return { token: token.token };
  },
});
