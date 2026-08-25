import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Echo the tool call identifiers.",
        inputSchema: z.object({ note: z.string() }),
        execute: ({ note }, toolCtx) => ({
          callId: toolCtx.callId,
          note,
          sessionId: ctx.session.id,
          toolName: toolCtx.toolName,
        }),
      }),
  },
});
