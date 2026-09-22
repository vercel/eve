import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: runtime-control finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "runtime-control", "background-task"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a background draft is running and its receipt has been acknowledged.
    const session = await t.session();
    await expectReply(
      t,
      await session.start(
        "Start the background draft and acknowledge its receipt.",
        scriptedSession,
      ),
      /^Background receipt: .*"status":"working"/,
    );

    // When the user asks to cancel that task.
    const live = await session.start("Cancel the background draft task and confirm cancellation.");

    // Then task_cancel completes once and its cancellation result gets a completed reply.
    const turn = await expectReply(t, live, /Cancellation result: .*"status":"cancelled"/);
    turn.calledTool("task_cancel", { status: "completed", count: 1 });
  },
});
