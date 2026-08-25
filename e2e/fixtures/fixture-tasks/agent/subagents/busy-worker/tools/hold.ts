import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Keep an admitted continuation nonterminal until its parent releases it.",
  inputSchema: z.object({ marker: z.literal("HOLD") }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, released: true }),
});
