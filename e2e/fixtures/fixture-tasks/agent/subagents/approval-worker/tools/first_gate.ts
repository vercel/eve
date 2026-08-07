import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "First deterministic approval gate.",
  inputSchema: z.object({ marker: z.literal("FIRST") }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, passed: true }),
});
