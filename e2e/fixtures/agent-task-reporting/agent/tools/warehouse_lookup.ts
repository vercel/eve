import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Ask the warehouse specialist for the third inventory item and wait for its result.",
  inputSchema: z.strictObject({ check: z.literal("third") }),
  async execute({ check }, ctx) {
    "use workflow";
    // Blocking delegation keeps the outer task open until the nested lookup finishes.
    return await ctx.agent("warehouse-worker", {
      message: `Alice needs the inventory item for check=${check}. Call probe with that check and report its result value.`,
    });
  },
});
