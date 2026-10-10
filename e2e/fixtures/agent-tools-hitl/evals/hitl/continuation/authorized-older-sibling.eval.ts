import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectApprovalCancelled,
  expectResponseReply,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "Asking for change A cancels a held response-authorized change, and approving A still completes.",
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
    // When the user asks for change A instead, which steers the held turn.
    const second = await session.send("Prepare change A.");
    const approvalA = requestFrom(second, "change-a");
    // Then the authorized change is cancelled and never runs.
    expectApprovalCancelled(session, authorized);
    // And approving A runs it once and completes the held turn.
    const live = await session.startRespond([
      { requestId: approvalA.requestId, optionId: "approve" },
    ]);
    const reply = await expectResponseReply(t, live, "Change A resolved.", approvalA.requestId);
    reply.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
  },
});
