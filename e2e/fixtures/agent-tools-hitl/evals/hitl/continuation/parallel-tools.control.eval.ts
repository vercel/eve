import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: parallel-tools finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "tool-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks to read and save in parallel.
    const live = await session.start("Read and save the draft in parallel.", scriptedSession);

    // Then both tools execute once and their results appear in a completed reply.
    const turn = await expectReply(t, live, 'Draft status: ready. Draft saved: {"writes":1}.');
    turn.calledTool("read-draft", { status: "completed", count: 1 });
    turn.calledTool("save-draft", { status: "completed", count: 1 });
  },
});
