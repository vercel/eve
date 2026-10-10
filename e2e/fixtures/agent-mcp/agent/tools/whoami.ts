import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Report who this call runs as and which service forwarded it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = ctx.session.auth.current;
    return {
      forwardedBy: current?.attributes["eve:forwarded-by"] ?? null,
      principalId: current?.principalId ?? null,
      principalType: current?.principalType ?? null,
    };
  },
});
