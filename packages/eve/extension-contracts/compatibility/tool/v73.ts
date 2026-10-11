import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 73 sign-ins didn't name the calls they stopped, and calls had no `cancelled` status.
// Compiled epoch 73 tools still park on sign-in through ctx.getToken; both are additive.
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
