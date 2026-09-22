import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: provider-result finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "provider-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks the provider to look up the draft.
    const live = await session.start(
      "Look up the draft with the provider and report its status.",
      scriptedSession,
    );

    // Then the reply reports provider-ready and completes its turn.
    const reply = await expectReply(t, live, "Provider draft status: provider-ready.");
    reply.calledTool("read-draft", {
      status: "completed",
      output: { status: "provider-ready" },
      count: 1,
    });
  },
});
