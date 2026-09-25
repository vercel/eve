import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: tool-error finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "tool-error"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks to read from a failing tool.
    const live = await session.start(
      "Try the unavailable draft store and explain the error.",
      scriptedSession,
    );

    // Then the reply explains the actual tool error and completes its turn.
    const turn = await expectReply(
      t,
      live,
      /Could not read the draft: .*The draft store is unavailable/,
    );
    turn.calledTool("unavailable-draft", { status: "failed", count: 1 });
  },
});
