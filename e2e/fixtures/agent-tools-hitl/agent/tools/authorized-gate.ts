import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "PROOF-ONLY: executes after an authenticated response policy allows approval.",
  inputSchema: z.object({ marker: z.string() }),
  approval: {
    request: always(),
    response: ({ response, responder }) =>
      response.decision === "approve" &&
      ["e2e-approval-responder", "e2e-approval-operator"].includes(responder.principalId)
        ? ({ status: "allowed" } as const)
        : ({ status: "rejected", reason: "Unexpected eval responder." } as const),
  },
  async execute({ marker }, ctx) {
    return { executed: true, marker, caller: ctx.session.auth.current?.principalId };
  },
});
