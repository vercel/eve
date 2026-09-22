import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectChangeStillUnexecuted,
  expectReply,
  requestFrom,
  expectToolResult,
} from "./helpers.ts";

export default defineEval({
  description: "A task-control result must be interpreted while an older approval waits.",
  tags: [
    "hitl",
    "continuation",
    "regression",
    "user-message",
    "runtime-control",
    "background-task",
  ],
  timeoutMs: 60_000,
  async test(t) {
    // Given a background draft is running and change A is waiting for approval.
    const session = await t.session();
    await expectReply(
      t,
      await session.start(
        "Start the background draft and acknowledge its receipt.",
        scriptedSession,
      ),
      /^Background receipt: .*"status":"working"/,
    );
    const parked = await session.send("Prepare change A.");
    requestFrom(parked, "change-a");

    // When the user asks to cancel that task.
    const live = await session.start("Cancel the background draft task and confirm cancellation.");

    // Then the reply confirms cancellation and completes; A stays unexecuted.
    await expectToolResult(t, live, "task_cancel");
    const turn = await expectReply(t, live, /Cancellation result: .*"status":"cancelled"/);
    turn.calledTool("task_cancel", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
  },
});
