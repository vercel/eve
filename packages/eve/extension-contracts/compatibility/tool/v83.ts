import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 83 tools read v27 session facts; epoch 84 removes the v26 work event types from the
// session event union. A tool that never named those types authors the same way.
export default defineTool({
  description: "Look up the on-call engineer for a service.",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ engineer: z.string(), service: z.string() }),
  execute: ({ service }) => ({ engineer: "oncall@example.com", service }),
});
