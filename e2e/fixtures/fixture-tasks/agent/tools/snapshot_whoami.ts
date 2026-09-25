import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Report the current and initiating principals for this session turn.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return {
      current: ctx.session.auth.current?.principalId ?? null,
      initiator: ctx.session.auth.initiator?.principalId ?? null,
    };
  },
});
