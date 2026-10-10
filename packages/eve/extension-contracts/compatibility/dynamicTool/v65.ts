import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 65 dynamic tool entries had no `endsTurn`; epoch 66 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": () => ({
      acknowledge: defineTool({
        description: "Acknowledge the message.",
        inputSchema: { type: "object", properties: {} },
        execute: () => "acknowledged",
      }),
    }),
  },
});
