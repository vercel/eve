import { defineEval } from "eve/evals";

import { SAY, aliceSession, asAlice, follow, signInFrom } from "../helpers.ts";

/** Alice cancels her turn while it waits for her sign-in: the sign-in is declined. */
export default defineEval({
  description: "Cancelling a turn held on a sign-in declines the sign-in.",
  tags: ["hitl", "human-input", "sign-in", "cancel"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const signIn = signInFrom(await session.send(SAY.checkAccess, asAlice));
    const startIndex = session.state.streamIndex;

    await session.cancel();
    const cancelled = await follow(t, session, startIndex);
    cancelled.event("authorization.completed", {
      count: 1,
      data: { attemptId: signIn.attemptId, outcome: "declined", reason: "Cancelled." },
    });
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.notEvent("step.started");
    cancelled.notEvent("action.result", { data: { status: "completed" } });
  },
});
