import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Fourth deterministic approval gate for continued-task HITL routing.",
  inputSchema: z.object({ marker: z.literal("FOURTH") }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, passed: true }),
});
