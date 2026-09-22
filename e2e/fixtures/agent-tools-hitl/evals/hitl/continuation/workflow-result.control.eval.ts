import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: workflow-result finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks a workflow to read the draft.
    const live = await session.start("Read the draft through a workflow.", scriptedSession);

    // Then the reply reports the workflow result and completes its turn.
    const turn = await expectReply(t, live, "Workflow draft status: ready.");
    turn.calledTool("workflow-draft", { status: "completed", count: 1 });
  },
});
