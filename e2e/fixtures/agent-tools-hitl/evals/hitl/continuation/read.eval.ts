import { defineEval } from "eve/evals";
import {
  scriptedSession,
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectReply,
  requestFrom,
  expectToolResult,
} from "./helpers.ts";

export default defineEval({
  description: "An older approval cannot silence the answer after a read.",
  tags: ["hitl", "continuation", "regression", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks to read the draft.
    const live = await session.start("Read the draft status.");

    // Then the reply reports ready and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "read-draft");
    const turn = await expectReply(t, live, "Draft status: ready.");
    turn.calledTool("read-draft", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
