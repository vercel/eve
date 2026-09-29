import { defineDynamic, defineTool } from "#public/tools/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 58 approval requests had no `requester`; it is additive.
export default defineDynamic({
  events: {
    "turn.started": () => ({
      refund: defineTool({
        description: "Refund a charge after an approver allows it.",
        inputSchema: { type: "object", properties: {} },
        approval: {
          request: always(),
          response: ({ responder }) =>
            responder.principalId === "approver"
              ? { status: "allowed" }
              : { status: "rejected", reason: "Only the approver can refund charges." },
        },
        execute: () => ({ refunded: true }),
      }),
    }),
  },
});
