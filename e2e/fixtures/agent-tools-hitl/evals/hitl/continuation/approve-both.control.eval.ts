import { defineEval } from "eve/evals";
import { scriptedSession, expectResponseReply, requestFrom } from "./helpers.ts";

export default defineEval({
  description: "Control: approving both calls together executes each once and completes the reply.",
  tags: ["hitl", "continuation", "control", "input-response", "partial-approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A and B were requested together and both await approval.
    const parked = await t.send("Prepare changes A and B together.", scriptedSession);
    const approvalA = requestFrom(parked, "change-a");
    const approvalB = requestFrom(parked, "change-b");

    // When the user approves both in one HTTP request.
    const live = await parked.session.startRespond([
      { requestId: approvalA.requestId, optionId: "approve" },
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
