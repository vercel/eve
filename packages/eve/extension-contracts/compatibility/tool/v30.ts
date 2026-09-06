import { z } from "zod";
import { defineTool, defineWorkflowTool, disableTool } from "#public/tools/index.js";

disableTool();

defineTool({
  description: "Write an approved message.",
  inputSchema: z.object({ message: z.string() }),
  approval: ({ toolInput }) => (toolInput?.message ? "user-approval" : "not-applicable"),
  execute: (input) => ({ written: input.message }),
});

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
