import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { PREFIX_REQUEST, prefixSchema } from "../lib/prompt-prefix";

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      ctx.messages.some((message) => message.role === "user" && message.content === PREFIX_REQUEST)
        ? defineTool({
            description: "Capture a prompt prefix for the durable cache regression eval.",
            inputSchema: z.object({ prefix: prefixSchema }),
            execute: async (input) => input.prefix,
          })
        : null,
  },
});
