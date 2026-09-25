import { z } from "zod";
import { defineWorkflowTool } from "#public/tools/index.js";

// Epoch 62 resumable bodies were async functions. Epoch 63 also accepts a
// generator body whose yields are progress; an async body is unchanged.
export const releaseNotes = defineWorkflowTool({
  description: "Draft release notes, then revise them on request.",
  inputSchema: z.object({ request: z.string() }),
  outputSchema: z.object({ notes: z.string() }),
  resumable: true,
  async execute(input, ctx) {
    "use workflow";
    let notes = `Notes for ${input.request}`;
    for (;;) {
      ctx.reply({ notes });
      const next = await ctx.receive();
      notes = `${notes}; ${next.request}`;
    }
  },
});
