import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Echo a value back with a fixture prefix.",
  inputSchema: z.strictObject({ value: z.string() }),
  outputSchema: z.string(),
  execute: ({ value }) => `ECHO:${value}`,
});
