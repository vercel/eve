import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

// Removing optional internal Workflow metadata does not change the resolver's public context.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const sessionId = ctx.session.id;
      return defineTool({
        description: "Report the current session and supplied label.",
        inputSchema: z.object({ label: z.string() }),
        execute: ({ label }) => ({ label, sessionId }),
      });
    },
  },
});
