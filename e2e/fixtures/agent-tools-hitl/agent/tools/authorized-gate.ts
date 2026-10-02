import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "PROOF-ONLY: executes after an authenticated response policy allows approval.",
  inputSchema: z.object({ marker: z.string() }),
  approval: {
    request: always(),
    response: ({ response }) =>
      response.decision === "approve" && response.principal.principalId === "e2e-approval-responder"
        ? ({ status: "allowed" } as const)
        : ({ status: "rejected", reason: "Unexpected eval responder." } as const),
  },
  async execute({ marker }) {
    return { executed: true, marker };
  },
});
