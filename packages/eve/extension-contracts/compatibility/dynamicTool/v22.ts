import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineTool({
        description: "Echo the current tool call.",
        inputSchema: z.object({ value: z.string() }),
        execute: ({ value }, ctx) => ({ callId: ctx.callId, toolName: ctx.toolName, value }),
      }),
  },
});
