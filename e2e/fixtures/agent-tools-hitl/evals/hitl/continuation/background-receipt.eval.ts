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
  description:
    "Starting a background task must produce an acknowledgement while an older approval waits.",
  tags: ["hitl", "continuation", "regression", "user-message", "background-task"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks to start a background draft.
    const live = await session.start("Start the background draft and acknowledge its receipt.");

    // Then the reply acknowledges its working receipt; A stays unexecuted and answerable.
    await expectToolResult(t, live, "background-draft");
    const turn = await expectReply(t, live, /^Background receipt: .*"status":"working"/);
    turn.calledTool("background-draft", { count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
    await expectReply(
      t,
      await session.start("Cancel the background draft task and confirm cancellation."),
      /Cancellation result: .*"status":"cancelled"/,
    );
  },
});
