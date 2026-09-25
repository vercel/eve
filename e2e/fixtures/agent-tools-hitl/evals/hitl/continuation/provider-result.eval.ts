import { defineEval } from "eve/evals";
import {
  scriptedSession,
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "A provider-executed tool result must get a follow-up model call while an older approval waits.",
  tags: ["hitl", "continuation", "regression", "user-message", "provider-result"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks the provider to look up the draft.
    const live = await session.start("Look up the draft with the provider and report its status.");

    // Then the reply reports provider-ready and completes; A stays unexecuted and answerable.
    await expectToolResult(t, live, "read-draft");
    const reply = await expectReply(t, live, "Provider draft status: provider-ready.");
    reply.calledTool("read-draft", {
      status: "completed",
      output: { status: "provider-ready" },
      count: 1,
    });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approval);
  },
});
