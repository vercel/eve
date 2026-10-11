import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 69 `endsTurn` accepted only a boolean; epoch 70 also accepts a function
// of the execute output. A boolean still ends the turn as before.
export default defineTool({
  description: "Add a reaction to the current message.",
  endsTurn: true,
  inputSchema: z.object({ emoji: z.string() }),
  outputSchema: z.object({ emoji: z.string() }),
  execute: ({ emoji }) => ({ emoji }),
});
