import { defineEval } from "eve/evals";

import { REPLY, SAY, aliceSession, asAlice, expectHeld, signInFrom } from "../helpers.ts";

/**
 * Alice's access check waits for her sign-in when she asks for a hello
 * instead. Her message steers the turn: the sign-in is declined, and the
 * model is told it ended so it asks again only if it still needs it.
 */
export default defineEval({
  description: "Steering past a sign-in declines it and tells the model which sign-in ended.",
  tags: ["hitl", "human-input", "sign-in", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.checkAccess, asAlice);
    expectHeld(held);
    const signIn = signInFrom(held);

    const steered = (await session.send(SAY.hello, asAlice)).expectOk();
    steered.notEvent("turn.started");
    steered.event("authorization.completed", {
      count: 1,
      data: {
        attemptId: signIn.attemptId,
        outcome: "declined",
        reason: "Cancelled because a new message arrived.",
      },
    });
    // The scripted model answers this way only when the sign-in note reached it.
    steered.event("message.completed", { data: { message: REPLY.helloAfterSignIn } });
    steered.notEvent("action.result", { data: { status: "completed" } });
  },
});
