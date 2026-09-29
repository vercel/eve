import { defineMcpClientConnection } from "#public/connections/index.js";
import { always } from "#public/tools/approval/index.js";

// Epoch 30 approval requests had no `requester`; it is additive.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval: {
    request: always(),
    response: ({ request, responder }) =>
      request.toolName.startsWith("search") || responder.principalId === "approver"
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the approver can run this tool." },
  },
});
