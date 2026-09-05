import { z } from "zod";
import { defineWorkflowTool } from "#public/tools/index.js";

defineWorkflowTool({
  description: "Ask before publishing a report.",
  execution: "background",
  inputSchema: z.object({ reportId: z.string() }),
  async *execute(input, ctx, task) {
    "use workflow";
    yield task.postMessage(`Preparing ${input.reportId}`);
    const answer = await ctx.ask({ prompt: "Publish this report?", allowFreeform: true });
    return { reportId: input.reportId, answer: answer.text, sessionId: ctx.session.id };
  },
});
