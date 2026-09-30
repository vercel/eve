import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 63 authorization events had no `principalId`. Compiled epoch 63 tools
// still park on sign-in through ctx.getToken; `principalId` is additive.
export default defineTool({
  description: "List the caller's open tickets.",
  inputSchema: z.object({ project: z.string() }),
  async execute({ project }, ctx) {
    const { token } = await ctx.getToken({
      principalType: "user",
      async getToken() {
        return { token: "ticket-token" };
      },
    });
    return { authorized: token.length > 0, project };
  },
});
