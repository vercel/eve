import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOnePassword } from "../../server/onepassword/oauth";
import { onePasswordPrincipal, safeOnePassword } from "../lib/onepassword-auth";
import { personalConnectionsEnabled } from "../../server/onepassword/config";
export default defineTool({
  description: "Check this authenticated sender's personal 1Password connection without exposing tokens, keys, or vault contents.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const principal = onePasswordPrincipal(ctx);
    if (!personalConnectionsEnabled()) return { status: "disabled" };
    return safeOnePassword(() => getOnePassword().status(principal));
  },
});
