import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMem0, memoryUserId } from "../lib/mem0";

export default defineTool({
  description:
    "Save a durable fact or preference about the user to long-term memory. " +
    "Use this whenever the user shares something worth remembering across sessions " +
    "(their name, preferences, goals, or context about their work).",
  inputSchema: z.object({
    content: z
      .string()
      .min(1)
      .describe("A single fact or preference to remember, in natural language."),
  }),
  label: { start: ({ content }) => `Remember: ${content.slice(0, 60)}` },
  async execute({ content }, ctx) {
    const userId = memoryUserId(ctx.session.auth.current?.principalId);
    await getMem0().add([{ role: "user", content }], { userId });
    return { saved: true };
  },
});
