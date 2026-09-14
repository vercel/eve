import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "PROOF-ONLY: only the authorized fixture responder may approve.",
  inputSchema: z.object({ marker: z.string() }),
  approval: {
    request: always(),
    response: ({ responder }) =>
      responder.principalId === "e2e-approval-responder"
        ? { status: "allowed" }
        : { status: "rejected", reason: "This responder is not authorized." },
  },
  async execute({ marker }) {
    return { executed: true, marker };
  },
});
