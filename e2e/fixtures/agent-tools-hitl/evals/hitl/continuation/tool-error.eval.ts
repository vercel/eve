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
  description: "A tool error must reach the user while an older approval remains open.",
  tags: ["hitl", "continuation", "regression", "user-message", "tool-error"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks to read from a failing tool.
    const live = await session.start("Try the unavailable draft store and explain the error.");

    // Then the reply explains the actual error and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "unavailable-draft");
    const turn = await expectReply(
      t,
      live,
      /Could not read the draft: .*The draft store is unavailable/,
    );
    turn.calledTool("unavailable-draft", { status: "failed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
