import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 66 dynamic tool entries accepted only a boolean `endsTurn`; epoch 67
// widens the type to match `defineTool`. A boolean still works as before.
export default defineDynamic({
  events: {
    "turn.started": () => ({
      acknowledge: defineTool({
        description: "Acknowledge the message.",
        endsTurn: true,
        inputSchema: { type: "object", properties: {} },
        execute: () => "acknowledged",
      }),
    }),
  },
});
