import { defineTool } from "eve/tools";
import { z } from "zod";
import { prefixSchema } from "../lib/prompt-prefix";

export default defineTool({
  description: "Retain the previous model request across a durable tool step.",
  inputSchema: z.object({ prefix: prefixSchema }),
  execute: async ({ prefix }) => prefix,
});
