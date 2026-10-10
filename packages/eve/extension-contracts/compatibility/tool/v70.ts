import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 70 `task.settled` events had no `cancel`; epoch 71 adds it as optional.
// Tools that start tasks keep working.
export default defineTool({
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
