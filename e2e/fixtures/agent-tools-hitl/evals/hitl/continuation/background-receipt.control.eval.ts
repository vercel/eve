import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: background-receipt finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "background-task"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks to start a background draft.
    const live = await session.start(
      "Start the background draft and acknowledge its receipt.",
      scriptedSession,
    );

    // Then the reply acknowledges its working receipt; a later cancellation also gets a reply.
    const turn = await expectReply(t, live, /^Background receipt: .*"status":"working"/);
    turn.calledTool("background-draft", { count: 1 });
    await expectReply(
      t,
      await session.start("Cancel the background draft task and confirm cancellation."),
      /Cancellation result: .*"status":"cancelled"/,
    );
  },
});
