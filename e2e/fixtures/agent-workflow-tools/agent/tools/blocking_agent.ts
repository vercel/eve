import { defineTool } from "eve/tools";
import { agent } from "eve/workflow";
import { z } from "zod";

export default defineTool({
  description: "Run one subagent from a waiting workflow tool.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await agent(ctx, {
      key: "blocking-child",
      message: `${service}:blocking`,
      target: "workflow-marker",
    });
  },
});
