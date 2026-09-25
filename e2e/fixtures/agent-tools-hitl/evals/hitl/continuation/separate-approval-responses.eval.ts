import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectResponseReply,
  requestFrom,
  submitPartialApproval,
} from "./helpers.ts";

export default defineEval({
  description:
    "Separate authenticated responses must accumulate until both approvals from one batch are answered.",
  tags: ["hitl", "continuation", "regression", "input-response", "partial-approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A and B were requested together and only A has an accepted approval response.
    const parked = await t.send("Prepare changes A and B together.", scriptedSession);
    const approvalA = requestFrom(parked, "change-a");
    const approvalB = requestFrom(parked, "change-b");
    const session = parked.session;
    await submitPartialApproval(t, session, approvalA);

    // When the user approves B in a separate HTTP request.
    const live = await session.startRespond([
      { requestId: approvalB.requestId, optionId: "approve" },
    ]);

    // Then both changes execute once and the resumed turn replies that both resolved.
    const reply = await expectResponseReply(t, live, "Both changes resolved.", approvalB.requestId);
    reply.event("input.resolved", {
      data: {
        resolutions: (items) =>
          [approvalA.requestId, approvalB.requestId].every((id) =>
            items.some((item) => item.requestId === id && item.outcome === "approved"),
          ),
      },
      count: 1,
    });
    reply.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    reply.calledTool("change-b", { status: "completed", output: { executions: 1 }, count: 1 });
  },
});
