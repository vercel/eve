import { defineEval } from "eve/evals";
import {
  expectApprovalCancelled,
  scriptedSession,
  expectChangeStillUnexecuted,
  expectReply,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "The model must be able to correct invalid tool input while an older approval waits.",
  tags: ["hitl", "continuation", "regression", "user-message", "validation"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks for a read that first uses an invalid draft ID.
    const live = await session.start(
      "Try a numeric draft ID, then correct it and read the status.",
    );

    // Then the model corrects the input and reports ready plus the validation error; the message cancelled A, which never runs.
    const rejectedStep = await live.waitForEvent("model.settled");
    t.log(
      `Initial tool-call step completed; awaiting correction: ${JSON.stringify(rejectedStep.data)}`,
    );
    const turn = await expectReply(t, live, /Draft status: ready\. Validation error: .*draftId/);
    turn.calledTool("read-draft", {
      status: "completed",
      input: { draftId: "draft-3494" },
      count: 1,
    });
    expectChangeStillUnexecuted(session);
    expectApprovalCancelled(session, approval);
  },
});
