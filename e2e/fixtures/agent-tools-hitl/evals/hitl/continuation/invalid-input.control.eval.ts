import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "Control: invalid-input finishes without an older approval.",
  tags: ["hitl", "continuation", "control", "user-message", "validation"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session has no pending approval.
    const session = await t.session();

    // When the user asks for a read that first uses an invalid draft ID.
    const live = await session.start(
      "Try a numeric draft ID, then correct it and read the status.",
      scriptedSession,
    );

    // Then the model corrects the ID and replies with ready plus the validation error.
    const turn = await expectReply(t, live, /Draft status: ready\. Validation error: .*draftId/);
    turn.calledTool("read-draft", {
      status: "completed",
      input: { draftId: "draft-3494" },
      count: 1,
    });
  },
});
