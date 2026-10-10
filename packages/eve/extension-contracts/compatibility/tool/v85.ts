import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 85 reached the v26 stream event types through client results; epoch 86 replaces
// them with v27 session events. Tools that don't read session events keep working.
export default defineTool({
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
