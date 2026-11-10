import { defineTool } from "eve/tools";
import { z } from "zod";

import { releaseAuth } from "../lib/hitl/release-auth.ts";

/** Uses the release token of the person `as` names, whom eve asks unless they spoke last. */
export default defineTool({
  description: "Use the release token of the person whose principalId `as` names.",
  inputSchema: z.object({ as: z.string() }),
  async execute({ as }, ctx) {
    const { token } = await ctx.getToken(releaseAuth, { as });
    return { token };
  },
});
