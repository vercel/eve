import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "step.started": async (event, ctx) => {
      const messageCount = ctx.messages.length;
      const toolResultCount = ctx.messages.filter((m) => m.role === "tool").length;

      return {
        check_messages: defineTool({
          description:
            "Returns the message count and tool-result count visible to the resolver. " +
            "Only call when the user explicitly asks to check messages.",
          inputSchema: z.object({ label: z.string().optional() }),
          async execute(input) {
            return {
              label: input.label ?? null,
              messageCount,
              toolResultCount,
            };
          },
        }),
      };
    },
  },
});
