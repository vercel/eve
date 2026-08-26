import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Record an audit entry for the current call.",
  inputSchema: z.object({ action: z.string() }),
  execute({ action }, ctx) {
    ctx.abortSignal.throwIfAborted();
    return {
      action,
      callId: ctx.callId,
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    };
  },
});
