import { defineDynamic, defineTool } from "#public/tools/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 54 dynamic tools could require approval without a presentation prompt.
export default defineDynamic({
  events: {
    "session.started": () => ({
      status: defineTool({
        approval: always(),
        description: "Report service status after approval.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ status: "ready" }),
      }),
    }),
  },
});
