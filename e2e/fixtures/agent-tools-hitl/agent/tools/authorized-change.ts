import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const executions = defineState("authorized-change.executions", () => 0);

export default defineTool({
  description: "Apply a change only after the fixture's authorized user approves it.",
  inputSchema: z.object({}),
  approval: {
    request: always(),
    response: ({ request, response }) => {
      // The person who asked for the change may withdraw it; only the fixture approver approves it.
      if (response.decision === "cancel") {
        return response.principal.principalId === request.principal?.principalId
          ? { status: "allowed" }
          : { status: "rejected", reason: "Only the requester can cancel this change." };
      }
      return response.principal.principalId === "e2e-approval-responder"
        ? { status: "allowed" }
        : { status: "rejected", reason: "Wrong responder." };
    },
  },
  async execute() {
    executions.update((count) => count + 1);
    return { change: "authorized", executions: executions.get() };
  },
});
