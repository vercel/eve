import { defineTool } from "#public/tools/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 57 tools could configure approval without a presentation prompt.
export default defineTool({
  approval: always(),
  description: "Require approval before reporting the service status.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: () => ({ status: "ready" }),
});
