import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Returns the message count and latest user text visible to this tool call. " +
    "Only call when the user explicitly asks to check context messages.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    const lastUser = [...ctx.messages].reverse().find((message) => message.role === "user");
    const lastUserText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : (lastUser?.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n") ?? null);
    return { lastUserText, messageCount: ctx.messages.length };
  },
});
