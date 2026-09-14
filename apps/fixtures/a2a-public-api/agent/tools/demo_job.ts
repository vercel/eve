import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Deterministic local demo: wait or ask one question.",
  inputSchema: z.object({
    kind: z.enum(["wait", "ask"]),
    seconds: z.number().min(0).max(120).default(2),
  }),
  async execute({ kind, seconds }, ctx) {
    "use workflow";
    if (kind === "ask") {
      const answer = await ctx.ask({ prompt: "Which city?", display: "text", allowFreeform: true });
      return { city: answer.text };
    }
    await sleep(`${seconds}s`);
    return { waited: seconds };
  },
});
