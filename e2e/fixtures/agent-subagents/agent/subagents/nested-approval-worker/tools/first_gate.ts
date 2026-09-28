import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";

export default defineTool({
  description: "Ask Alice to approve the first release checklist gate.",
  inputSchema: {},
  approval: once(),
  execute: async () => "first gate approved",
});
