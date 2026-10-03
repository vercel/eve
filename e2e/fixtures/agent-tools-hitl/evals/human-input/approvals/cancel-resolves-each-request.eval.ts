import { defineEval } from "eve/evals";

import { SAY, aliceSession, approvalFor, asAlice, expectResolved, follow } from "../helpers.ts";

/**
 * Alice cancels her turn while changes A and B wait. Each request resolves
 * once as cancelled, neither runs, and the model later reads a not-run result
 * for each call.
 */
export default defineEval({
  description: "Cancelling a held turn resolves each open approval once as cancelled.",
  tags: ["hitl", "human-input", "approval", "cancel"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changesAB, asAlice);
    const a = approvalFor(asked, "change-a");
    const b = approvalFor(asked, "change-b");
    const startIndex = session.state.streamIndex;

    await session.cancel();
    const cancelled = await follow(t, session, startIndex);
    expectResolved(cancelled, a, "cancelled");
    expectResolved(cancelled, b, "cancelled");
    cancelled.event("input.resolved", { count: 2 });
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.notEvent("action.result", { data: { status: "completed" } });
    cancelled.notEvent("step.started");

    const after = (await session.send(SAY.whatHappened, asAlice)).expectOk();
    after.event("message.completed", {
      data: { message: "Change A: not run. Change B: not run." },
    });
  },
});
