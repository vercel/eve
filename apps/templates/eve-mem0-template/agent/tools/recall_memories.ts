import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMem0, memoryUserId } from "../lib/mem0";

export default defineTool({
  description:
    "Search the user's long-term memory for facts relevant to a query. " +
    "Call this before answering anything personal so replies use what you already know about the user.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("What to look up, e.g. the user's question or the current topic."),
  }),
  label: { start: ({ query }) => `Recall: ${query.slice(0, 60)}` },
  async execute({ query }, ctx) {
    const userId = memoryUserId(ctx.session.auth.current?.principalId);
    const res = (await getMem0().search(query, {
      filters: { user_id: userId },
    })) as unknown;

    // Mem0 returns either an array of memories or an object with a `results` array.
    const items = Array.isArray(res) ? res : ((res as { results?: unknown[] }).results ?? []);
    const memories = (items as Array<{ memory?: string }>)
      .map((item) => item.memory)
      .filter((memory): memory is string => Boolean(memory));

    return { memories };
  },
});
