import { z } from "zod";
import { defineWorkflowTool } from "#public/tools/index.js";

// Epoch 58 answers had no `responder`. Compiled epoch 58 tools still read
// `status`, `optionId`, and `text`; `responder` is additive.
export default defineWorkflowTool({
  description: "Ask a person to confirm a deploy before continuing.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    const answer = await ctx.ask({
      display: "confirmation",
      options: [{ id: "approve", label: "Deploy" }],
      prompt: `Deploy ${service}?`,
    });
    return { approved: answer.status === "answered" && answer.optionId === "approve", service };
  },
});
