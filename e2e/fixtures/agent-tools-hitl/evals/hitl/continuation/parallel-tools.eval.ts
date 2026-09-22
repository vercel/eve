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
  description: "An older approval cannot silence the reply after parallel reads and writes.",
  tags: ["hitl", "continuation", "regression", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks to read and save in parallel.
    const live = await session.start("Read and save the draft in parallel.");

    // Then the reply reports both results and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "save-draft");
    const turn = await expectReply(t, live, 'Draft status: ready. Draft saved: {"writes":1}.');
    turn.calledTool("read-draft", { status: "completed", count: 1 });
    turn.calledTool("save-draft", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
