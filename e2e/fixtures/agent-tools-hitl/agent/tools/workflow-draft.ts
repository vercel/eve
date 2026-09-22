import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Read a draft through a durable workflow tool.",
  inputSchema: z.object({}),
  async execute() {
    "use workflow";
    return { status: "ready" };
  },
});
