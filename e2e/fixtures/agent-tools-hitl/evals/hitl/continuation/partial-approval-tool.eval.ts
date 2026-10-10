import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  scriptedSession,
  expectChangeStillUnexecuted,
  expectReply,
  expectToolResult,
  requestFrom,
  submitPartialApproval,
} from "./helpers.ts";

export default defineEval({
  description:
    "A partial approval must not prevent a new tool message from receiving a completed reply.",
  tags: ["hitl", "continuation", "regression", "user-message", "partial-approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A and B were requested together and only A has an accepted approval response.
    const parked = await t.send("Prepare changes A and B together.", scriptedSession);
    const approvalA = requestFrom(parked, "change-a");
    const approvalB = requestFrom(parked, "change-b");
    const session = parked.session;
    await submitPartialApproval(t, session, approvalA);
    // When the user sends a message instead of answering B, which steers the held turn.
    const live = await session.start("Read the draft status.");
    await expectToolResult(t, live, "read-draft");
    const reply = await expectReply(t, live, "Draft status: ready.");
    // Then A keeps its approval and runs once, B is cancelled, and the message gets its reply.
    reply.event("interaction.settled", {
      data: { interactionId: approvalA.requestId, outcome: "accepted" },
      count: 1,
    });
    reply.event("interaction.settled", {
      data: { interactionId: approvalB.requestId, outcome: "withdrawn" },
      count: 1,
    });
    reply.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectChangeStillUnexecuted(session, "change-b");
    t.check(session.pendingInputRequests.length, equals(0));
  },
});
