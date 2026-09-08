import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return the identity installed by interactive sender authentication.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return ctx.session.auth.current;
  },
});
