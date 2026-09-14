import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Report deployment progress.",
        inputSchema: z.object({ service: z.string() }),
        outputSchema: z.object({ url: z.string() }),
        execute: async ({ service }) => ({ url: `https://${service}.example.com` }),
      }),
  },
});
