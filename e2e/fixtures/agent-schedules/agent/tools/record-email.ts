import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send a deterministic fixture email to the authenticated recipient.",
  inputSchema: z
    .object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1) })
    .strict(),
  // Only the unattended scheduled run sends the fixture email; anything else needs approval.
  approval: ({ session }) =>
    session.auth.current?.attributes["eve.scheduled_run"] === "true"
      ? "not-applicable"
      : "user-approval",
  async execute(input, context) {
    if (input.to !== context.session.auth.current?.attributes["fixture.email"])
      throw new Error("Fixture email recipient is not authorized.");
    return { accepted: true, recipient: input.to, token: "schedule-email-mock-accepted" };
  },
});
