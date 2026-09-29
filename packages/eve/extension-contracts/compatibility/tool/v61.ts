import { z } from "zod";
import { defineTool } from "#public/tools/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 61 approval requests had no `requester`. Compiled epoch 61 response
// policies still read `responder` and `request`; `requester` is additive.
export default defineTool({
  description: "Refund a charge after an approver allows it.",
  inputSchema: z.object({ chargeId: z.string() }),
  approval: {
    request: always(),
    response: ({ request, responder }) =>
      request.toolName === "refund" && responder.principalId === "approver"
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the approver can refund charges." },
  },
  execute: ({ chargeId }) => ({ chargeId, refunded: true }),
});
