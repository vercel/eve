import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 dynamic tool approval policies that decide without tool annotations remain supported.
export default defineDynamic({
  events: {
    "session.started": () => ({
      restart: defineTool({
        approval: ({ toolName }) => (toolName === "restart" ? "user-approval" : "not-applicable"),
        description: "Restart the service after approval.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ restarted: true }),
      }),
    }),
  },
});
