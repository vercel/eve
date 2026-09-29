import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Ask Alice to approve the second release checklist gate.",
  inputSchema: z.object({}),
  approval: once(),
  execute: async () => "second gate approved",
});
