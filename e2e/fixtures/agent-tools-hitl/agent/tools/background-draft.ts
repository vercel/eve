import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Hold a background draft task open until the eval cancels it.",
  execution: "background",
  inputSchema: z.object({}),
  async execute() {
    "use workflow";
    await sleep("10m");
    return { status: "ready" };
  },
});
