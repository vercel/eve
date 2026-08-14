import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Second deterministic approval gate.",
  inputSchema: z.object({ marker: z.literal("SECOND") }),
  approval: once(),
  execute: async ({ marker }) => ({ marker, passed: true }),
});
