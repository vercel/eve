import { defineTool } from "eve/tools";
import { z } from "zod";

import { releaseAuth } from "../lib/hitl/release-auth.ts";

/** Uses the caller's own release token, which eve hands out only while the caller spoke last. */
export default defineTool({
  description: "Use the caller's release token.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { token } = await ctx.getToken(releaseAuth);
    return { token };
  },
});
