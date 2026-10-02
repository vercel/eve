import { defineEval } from "eve/evals";
import {
  expectApprovalCancelled,
  scriptedSession,
  expectChangeStillUnexecuted,
  expectReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "An approval requiring an authenticated responder cannot silence an unrelated tool reply.",
  tags: ["hitl", "continuation", "regression", "user-message", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a change is waiting for approval from an authorized responder.
    const parked = await t.send("Prepare an authorized change.", scriptedSession);
    const approval = requestFrom(parked, "authorized-change");
    const session = parked.session;

    // When the user asks to read the draft.
    const live = await session.start("Read the draft status.");

    // Then the reply reports ready and completes; the message cancelled the authorized change, which never runs.
    await expectToolResult(t, live, "read-draft");
    await expectReply(t, live, "Draft status: ready.");
    expectChangeStillUnexecuted(session, "authorized-change");
    expectApprovalCancelled(session, approval);
  },
});
