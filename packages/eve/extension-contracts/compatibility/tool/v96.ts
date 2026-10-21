import { defineTool } from "#public/tools/index.js";

// Epoch 96 had no `replay` option; epoch 97 adds it as an optional field, which is additive.
export default defineTool({
  description: "Send a receipt for the order.",
  inputSchema: {},
  execute(_input, ctx) {
    return { callId: ctx.callId };
  },
});
