import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const executions = defineState("frozen-change.executions", () => 0);

/**
 * Asks for approval, and denies outright while the caller's fixture flag is
 * "freeze". eve checks the policy again before an approved call runs, so an
 * approval sent during a freeze still never runs the change.
 */
export default defineTool({
  description: "Apply the fixture change unless a change freeze is on.",
  inputSchema: z.object({}),
  approval: ({ session }) =>
    session.auth.current?.attributes?.flag === "freeze"
      ? { type: "denied", reason: "A change freeze is in effect." }
      : "user-approval",
  async execute() {
    executions.update((count) => count + 1);
    return { change: "frozen", executions: executions.get() };
  },
});
