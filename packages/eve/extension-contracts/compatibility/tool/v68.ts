import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 68 tool definitions had no `endsTurn`; epoch 69 adds it as optional to
// every defineTool overload. A tool that omits it continues the turn as before.
export default defineTool({
  description: "Add a reaction to the current message.",
  inputSchema: z.object({ emoji: z.string() }),
  outputSchema: z.object({ emoji: z.string() }),
  execute: ({ emoji }) => ({ emoji }),
});
