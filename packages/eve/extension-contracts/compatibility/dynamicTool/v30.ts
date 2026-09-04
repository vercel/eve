import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Deploy a project.",
        inputSchema: z.object({ project: z.string() }),
        label: { start: ({ project }) => `Deploy ${project}` },
        execute: ({ project }) => ({ project, status: "deployed" }),
      }),
  },
});
