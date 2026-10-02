import { z } from "zod";
import { defineWorkflowTool } from "#public/tools/index.js";

// Epoch 54 answers carried only `optionId` and `text`. Compiled epoch 54 tools
// still read those fields at runtime; `status` is additive.
export const confirm = defineWorkflowTool({
  description: "Ask a person to confirm a deploy before continuing.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    const answer = await ctx.ask({
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: `Deploy ${service}?`,
    });
    return { answer, service };
  },
});
