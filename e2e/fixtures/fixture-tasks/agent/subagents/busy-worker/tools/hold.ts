import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Keep an admitted continuation nonterminal long enough for a later-turn check.",
  inputSchema: z.object({ marker: z.literal("HOLD") }),
  execute: async ({ marker }) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return { marker, released: true };
  },
});
