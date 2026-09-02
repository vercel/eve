import { defineTool } from "eve/tools";
import { agent } from "eve/workflow";
import { z } from "zod";

export default defineTool({
  description: "Run one subagent from a background workflow tool.",
  execution: "background",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await agent(ctx, {
      key: "background-child",
      message: `${service}:background`,
      target: "workflow-marker",
    });
  },
});
