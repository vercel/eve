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
    response: ({ responder }) =>
      responder.principalId === "e2e-approval-responder"
        ? { status: "allowed" }
        : { status: "rejected", reason: "Wrong responder." },
  },
  async execute() {
    executions.update((count) => count + 1);
    return { change: "authorized", executions: executions.get() };
  },
});
