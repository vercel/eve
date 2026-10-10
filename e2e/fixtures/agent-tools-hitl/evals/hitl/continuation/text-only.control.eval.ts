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
    "Control: a text-only follow-up completes while the original approval stays answerable.",
  tags: ["hitl", "continuation", "control", "user-message", "text-reply"],
  timeoutMs: 60_000,
  async test(t) {
    // Given change A is waiting for approval.
    const parked = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(parked, "change-a");
    const session = parked.session;

    // When the user asks what is waiting without requesting tools.
    const live = await session.start("Explain what is waiting, without calling any tools.");

    // Then the text reply completes; the message cancelled A, which never runs.
    const reply = await expectReply(t, live, "Your changes are waiting for approval.");
    // The cancelled approval reports a not-run result; the reply itself calls no tools.
    reply.notEvent("actions.requested");
    expectChangeStillUnexecuted(session);
    expectApprovalCancelled(session, approval);
  },
});
