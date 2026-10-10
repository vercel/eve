import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  select: (view) => ({
    messageCount: view.messages.length,
    toolResultCount: view.messages.filter((message) => message.role === "tool").length,
  }),
  resolve: async ({ messageCount, toolResultCount }) => ({
    check_messages: defineTool({
      description:
        "Returns the message count and tool-result count visible to the resolver. " +
        "Only call when the user explicitly asks to check messages.",
      inputSchema: z.object({ label: z.string().optional() }),
      async execute(input) {
        return { label: input.label ?? null, messageCount, toolResultCount };
      },
    }),
  }),
});
