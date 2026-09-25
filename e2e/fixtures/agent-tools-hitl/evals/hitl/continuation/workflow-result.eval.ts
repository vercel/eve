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
  description: "A completed workflow result must be interpreted for the current user message.",
  tags: ["hitl", "continuation", "regression", "user-message", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks a workflow to read the draft.
    const live = await session.start("Read the draft through a workflow.");

    // Then the reply reports the workflow result and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "workflow-draft");
    const turn = await expectReply(t, live, "Workflow draft status: ready.");
    turn.calledTool("workflow-draft", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
