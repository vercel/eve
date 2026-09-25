import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: read finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks to read the draft.
    const live = await session.start("Read the draft status.", scriptedSession);

    // Then the reply reports ready and completes its turn.
    const turn = await expectReply(t, live, "Draft status: ready.");
    turn.calledTool("read-draft", { status: "completed", count: 1 });
  },
});
