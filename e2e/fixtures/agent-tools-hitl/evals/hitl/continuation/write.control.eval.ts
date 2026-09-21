import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: write finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks to save the draft.
    const live = await session.start(
      "Save the draft and report how many times it was written.",
      scriptedSession,
    );

    // Then the reply confirms one write and completes its turn.
    const turn = await expectReply(t, live, 'Draft saved: {"writes":1}.');
    turn.calledTool("save-draft", { status: "completed", count: 1 });
  },
});
