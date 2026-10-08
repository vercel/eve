import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Record the release step.",
  inputSchema: z.strictObject({}),
  execute: () => ({ recorded: true }),
});
