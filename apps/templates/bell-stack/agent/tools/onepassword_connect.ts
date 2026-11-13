import { defineTool } from "eve/tools";
import { z } from "zod";
import { onePasswordAuth, onePasswordPrincipal } from "../lib/onepassword-auth";
import { requirePersonalConnections } from "../../server/onepassword/config";
export default defineTool({
  description: "Connect this authenticated private iMessage sender's personal 1Password account. The private authorization link is delivered by the channel. Connecting alone does not approve any login.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    onePasswordPrincipal(ctx);
    requirePersonalConnections();
    await ctx.getToken(onePasswordAuth, { authKey: "onepassword" });
    return { status: "connected", loginApprovalRequired: true };
  },
});
