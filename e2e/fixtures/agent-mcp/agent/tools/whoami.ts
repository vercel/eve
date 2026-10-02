import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Report who this call runs as.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = ctx.session.auth.current;
    return {
      principalId: current?.principalId ?? null,
      principalType: current?.principalType ?? null,
    };
  },
});
