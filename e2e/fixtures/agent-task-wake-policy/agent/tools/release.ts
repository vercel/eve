import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Wait for Alice to release this report.",
  inputSchema: z.object({ marker: z.enum(["A", "B", "C"]) }),
  approval: once(),
  execute: async ({ marker }) => ({ marker }),
});
