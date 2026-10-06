import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 80 tools had no `deferred`; epoch 81 adds it as optional.
// Tools that leave it unset stay in the model's tool list.
export default defineTool({
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
