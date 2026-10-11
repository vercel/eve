import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 64 tool contexts had no `messages`. Compiled epoch 64 tools read only
// the context members they knew about; `messages` is additive.
export default defineTool({
  description: "Look up the status of an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute({ orderId }, ctx) {
    return { callId: ctx.callId, orderId, sessionId: ctx.session.id };
  },
});
