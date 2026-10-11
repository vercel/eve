import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 81 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 82 adds `name` to `load-skill`
// requests and requires it on results. Tools that don't read skill loads keep working.
export default defineTool({
  deferred: true,
  description: "Summarize the open incidents for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ service: z.string(), summary: z.string() }),
  execute: ({ service }) => ({ service, summary: `No open incidents for ${service}.` }),
});
