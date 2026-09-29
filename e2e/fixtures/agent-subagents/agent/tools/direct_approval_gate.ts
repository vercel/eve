import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";

export default defineTool({
  description: "Ask Alice to approve her release checklist in the remote agent.",
  inputSchema: {},
  approval: once(),
  execute: async () => "Alice approved the release checklist.",
});
