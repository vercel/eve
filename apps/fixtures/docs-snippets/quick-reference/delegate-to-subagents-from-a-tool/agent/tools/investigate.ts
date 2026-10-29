import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Ask the analyst and researcher in parallel and return both answers.",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx) {
    "use workflow";
    const [analyst, researcher] = await Promise.all([
      ctx.agent("analyst").send(question, { signal: ctx.abortSignal }),
      ctx.agent("researcher").send(question, { signal: ctx.abortSignal }),
    ]);
    const [a, r] = await Promise.all([analyst.result(), researcher.result()]);
    return { analyst: a.reply, researcher: r.reply };
  },
});
