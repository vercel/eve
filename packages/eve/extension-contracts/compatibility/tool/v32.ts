import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Build a report.",
  inputSchema: z.object({ project: z.string() }),
  label: {
    start: ({ project }) => `Build ${project}`,
    delta: (_input, partial) => JSON.stringify(partial),
    complete: (_input, output) => JSON.stringify(output),
  },
  async *execute({ project }) {
    yield { phase: "building", project };
    return { phase: "complete", project };
  },
});
