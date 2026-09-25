import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Ask the warehouse specialist for the third inventory item and wait for its result.",
  inputSchema: z.strictObject({ check: z.literal("third") }),
  async execute({ check }, ctx) {
    "use workflow";
    // Blocking delegation keeps the outer task open until the nested lookup finishes.
    return await ctx.agent("warehouse-worker", {
      message: `Alice is preparing an inventory checklist for Bob's warehouse handoff. Your entry is check=${check}. Please use the inventory lookup tool (probe) for this entry and share the item it returns.`,
    });
  },
});
