import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectApprovalStillOpen,
  expectResponseReply,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "Asking for change A keeps a held response-authorized change open, and approving A still replies.",
  tags: ["hitl", "continuation", "regression", "input-response", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a response-authorized change holds the turn.
    const first = await t.send(
      "Prepare an authorized change, then read the draft status.",
      scriptedSession,
    );
    const authorized = requestFrom(first, "authorized-change");
    const session = first.session;
    // When the user asks for change A instead, which joins the held turn.
    const second = await session.send("Prepare change A.");
    const approvalA = requestFrom(second, "change-a");
    // Then the authorized change stays open and never runs.
    expectApprovalStillOpen(session, authorized);
    // And approving A runs it once and replies, while the authorized change still waits.
    const live = await session.startRespond([
      { interactionId: approvalA.interactionId, optionId: "approve" },
    ]);
    const reply = await expectResponseReply(t, live, "Change A resolved.", approvalA.interactionId);
    reply.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
  },
});
