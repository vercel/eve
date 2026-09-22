import { defineTool } from "#tools/definition.js";
import { z } from "#compiled/zod/index.js";

export default defineTool({
  description: "Return the session identity for an audit.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return { sessionId: ctx.session.id, callId: ctx.callId };
  },
});
