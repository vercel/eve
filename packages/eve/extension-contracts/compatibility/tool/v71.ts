import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 71 `session.waiting`, `session.failed`, and `session.completed` events had no `usage`; epoch 72 adds it as optional.
export default defineTool({
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
