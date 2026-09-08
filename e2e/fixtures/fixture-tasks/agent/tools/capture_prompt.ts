import { defineTool } from "eve/tools";
import { prefixSchema } from "../lib/prompt-prefix";

export default defineTool({
  description: "Retain model-request fingerprints across durable steps and parent wakes.",
  inputSchema: prefixSchema,
  execute: async (input) => input,
});
