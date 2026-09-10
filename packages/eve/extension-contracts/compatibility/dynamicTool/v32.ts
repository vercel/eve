import { z } from "zod";

import { defineDurableCallback, defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Report the current session and supplied label.",
        inputSchema: z.object({ label: z.string() }),
        execute: defineDurableCallback({
          closure: { sessionId: ctx.session.id },
          callback: ({ sessionId }, { label }: { label: string }) => ({ label, sessionId }),
        }),
      }),
  },
});
