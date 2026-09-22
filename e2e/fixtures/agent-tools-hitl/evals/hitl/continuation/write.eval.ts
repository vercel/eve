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
  description: "An older approval cannot silence confirmation of a completed write.",
  tags: ["hitl", "continuation", "regression", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks to save the draft.
    const live = await session.start("Save the draft and report how many times it was written.");

    // Then the reply confirms one write and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "save-draft");
    const turn = await expectReply(t, live, 'Draft saved: {"writes":1}.');
    turn.calledTool("save-draft", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
