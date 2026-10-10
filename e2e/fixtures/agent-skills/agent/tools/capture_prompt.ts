import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { PREFIX_REQUEST, prefixSchema } from "../lib/prompt-prefix";

export default defineDynamic({
  select: (view) =>
    view.messages.some((message) => message.role === "user" && message.content === PREFIX_REQUEST),
  resolve: (prefixed) =>
    prefixed
      ? defineTool({
          description: "Capture a prompt prefix for the durable cache regression eval.",
          inputSchema: z.object({ prefix: prefixSchema }),
          execute: async (input) => input.prefix,
        })
      : null,
});
