import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Third deterministic approval gate for repeated HITL routing.",
  inputSchema: z.object({ marker: z.literal("THIRD") }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, passed: true }),
});
