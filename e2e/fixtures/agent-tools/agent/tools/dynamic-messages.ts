import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic(async (ctx) => {
  const messages = await ctx.messages();
  const messageCount = messages.length;
  const toolResultCount = messages.filter((message) => message.role === "tool").length;
  return {
    check_messages: defineTool({
      description:
        "Returns the message count and tool-result count visible to the resolver. " +
        "Only call when the user explicitly asks to check messages.",
      inputSchema: z.object({ label: z.string().optional() }),
      async execute(input) {
        return { label: input.label ?? null, messageCount, toolResultCount };
      },
    }),
  };
});
