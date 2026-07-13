import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Returns the identity attached to the current eve session.",
  inputSchema: z.object({}),
  execute: async (_input, ctx) => {
    const caller = ctx.session.auth.current;

    if (caller === null) return { signedIn: false };

    return {
      attributes: caller.attributes,
      authenticator: caller.authenticator,
      issuer: caller.issuer,
      principalId: caller.principalId,
      principalType: caller.principalType,
      signedIn: true,
    };
  },
});
