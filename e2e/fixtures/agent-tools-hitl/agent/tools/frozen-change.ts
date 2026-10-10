import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const executions = defineState("frozen-change.executions", () => 0);
const freezeStarted = defineState("frozen-change.freeze-started", () => false);

/** A freeze begins after consent, but applies only to the requesting caller. */
export default defineTool({
  description: "Apply the fixture change unless the requester's change freeze is on.",
  inputSchema: z.object({}),
  approval: {
    request: ({ session }) =>
      freezeStarted.get() && session.auth.current?.attributes?.flag === "freeze"
        ? { type: "denied", reason: "A change freeze is in effect." }
        : "user-approval",
    response: ({ response }) => {
      if (response.principal.principalId !== "bob")
        return { reason: "Only Bob may approve the frozen change.", status: "rejected" };
      // Simulate a policy change between asking and execution. Bob is not frozen.
      freezeStarted.update(() => true);
      return { status: "allowed" };
    },
  },
  async execute() {
    executions.update((count) => count + 1);
    return { change: "frozen", executions: executions.get() };
  },
});
