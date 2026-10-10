import { defineEval } from "eve/evals";
import {
  expectApprovalCancelled,
  scriptedSession,
  expectChangeStillUnexecuted,
  expectResponseReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "cancel-sibling: resolving the current request must finish its work while change A still waits.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A and B await separate approvals, and B must be followed by a read.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare change B, then read the draft status.");
    const current = requestFrom(second, "change-b");

    // When the user cancels B only.
    const live = await session.startRespond([{ requestId: current.requestId, optionId: "cancel" }]);

    // Then B does not execute and the read gets a completed reply; the message cancelled A, which never runs.
    await expectToolResult(t, live, "read-draft");
    const reply = await expectResponseReply(t, live, "Draft status: ready.", current.requestId);
    reply.calledTool("change-b", { status: "completed", count: 0 });
    expectChangeStillUnexecuted(session);
    expectApprovalCancelled(session, approvalA);
  },
});
