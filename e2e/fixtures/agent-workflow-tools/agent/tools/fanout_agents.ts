import { defineTool } from "eve/tools";
import { agent } from "eve/workflow";
import { z } from "zod";

export default defineTool({
  description: "Call two workflow-owned subagents in parallel and return both inline results.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await Promise.all([
      agent(ctx, {
        key: "replica-0",
        message: `${service}:replica-0`,
        target: "workflow-marker",
      }),
      agent(ctx, {
        key: "replica-1",
        message: `${service}:replica-1`,
        target: "workflow-marker",
      }),
    ]);
  },
});
