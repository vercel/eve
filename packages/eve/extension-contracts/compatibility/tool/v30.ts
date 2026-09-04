import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Build a report.",
  inputSchema: z.object({ project: z.string() }),
  label: { start: ({ project }) => `Build ${project}` },
  execute: ({ project }) => ({ project }),
});
