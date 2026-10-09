import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 84 client stream options could set `streamIdleReconnectPolicy`; epoch 85 removes it,
// since a session stream now sends heartbeats and ends with `stream.ended`. Tools keep working.
export default defineTool({
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
