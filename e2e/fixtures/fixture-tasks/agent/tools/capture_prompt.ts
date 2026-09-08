import { defineTool } from "eve/tools";
import { promptCheckpointSchema } from "../lib/prompt-prefix";

export default defineTool({
  description: "Save the current prompt so the next model call can compare against it.",
  inputSchema: promptCheckpointSchema,
  execute: async (input) => input,
});
