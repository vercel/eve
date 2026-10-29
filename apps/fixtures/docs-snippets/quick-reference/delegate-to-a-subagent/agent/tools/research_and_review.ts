import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Research a question, then have the reviewer check the answer.",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx) {
    "use workflow";
    const research = await ctx.agent("researcher").send(question, { signal: ctx.abortSignal });
    const { reply: draft } = await research.result();
    const review = await ctx
      .agent("reviewer")
      .send(`Check this answer to "${question}":\n\n${draft}`, { signal: ctx.abortSignal });
    const { reply: verdict } = await review.result();
    return { draft, verdict };
  },
});
