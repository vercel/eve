import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  expectApprovalCancelled,
  expectChangeStillUnexecuted,
  requestFrom,
  scriptedSession,
} from "./helpers.ts";

export default defineEval({
  description:
    "Answering an approval that steering cancelled runs nothing and steers the turn like a message.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given asking for an authorized change cancelled A's held approval.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare an authorized change, then read the draft status.");
    const newer = requestFrom(second, "authorized-change");
    expectApprovalCancelled(session, approvalA);
    // When the user still answers A, from an old prompt.
    const stale = await session.respond([{ requestId: approvalA.requestId, optionId: "approve" }]);
    // Then the stale answer becomes new input, which steers the held turn like any message:
    // the newer change is cancelled too, and nothing runs.
    stale.expectOk();
    stale.notEvent("turn.started");
    stale.event("message.completed", { count: 1 });
    expectApprovalCancelled(session, newer);
    expectChangeStillUnexecuted(session);
    t.check(session.pendingInputRequests.length, equals(0));
  },
});
