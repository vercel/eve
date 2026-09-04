import { z } from "zod";

import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Deploy a service.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }) {
    return { deployed: service };
  },
});
