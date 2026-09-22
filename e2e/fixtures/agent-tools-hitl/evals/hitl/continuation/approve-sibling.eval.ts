import { defineEval } from "eve/evals";
import {
  scriptedSession,
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectResponseReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "approve-sibling: resolving the current request must finish its work while change A still waits.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A and B await separate approvals, and B must be followed by a read.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare change B, then read the draft status.");
    const current = requestFrom(second, "change-b");

    // When the user approves B only.
    const live = await session.startRespond([
      { requestId: current.requestId, optionId: "approve" },
    ]);

    // Then B executes once and the read gets a completed reply; A stays unexecuted and answerable.
    await expectToolResult(t, live, "read-draft");
    const reply = await expectResponseReply(t, live, "Draft status: ready.", current.requestId);
    reply.calledTool("change-b", { status: "completed", output: { executions: 1 }, count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approvalA);
  },
});
