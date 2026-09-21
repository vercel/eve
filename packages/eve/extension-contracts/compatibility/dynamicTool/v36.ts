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
          complete: ({ service }, { url }) => `Deployed ${service} to ${url}`,
          delta: ({ service }) => `Deploying ${service}`,
          start: ({ service }) => `Deploy ${service}`,
        },
        execute: async ({ service }) => ({ url: `https://${service}.example.com` }),
      }),
  },
});
