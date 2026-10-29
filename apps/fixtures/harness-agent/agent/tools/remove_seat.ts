import { defineTool } from "eve/tools";
import { z } from "zod";

// Declared by the agent; its harness offers it only on the enterprise plan.
export default defineTool({
  description: "Remove a seat from the customer's account.",
  inputSchema: z.object({ email: z.string() }),
  execute: async ({ email }) => ({ removed: email }),
});
