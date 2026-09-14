import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Report deployment progress.",
        inputSchema: z.object({ service: z.string() }),
        outputSchema: z.object({ url: z.string() }),
        label: {
          start: ({ service }) => `Deploy ${service}`,
          delta: ({ service }) => `Deploying ${service}`,
          complete: ({ service }, { url }) => `Deployed ${service} to ${url}`,
        },
        execute: async ({ service }) => ({ url: `https://${service}.example.com` }),
      }),
  },
});
