import { defineEval } from "eve/evals";

import { REPLY, SAY, aliceSession, asAlice, expectHeld, authorizationFrom } from "../helpers.ts";

/**
 * Alice's access check waits for her authorization when she asks for a hello
 * instead. Her message steers the turn: the authorization is declined, and the
 * model is told it ended so it asks again only if it still needs it.
 */
export default defineEval({
  description:
    "Steering past an authorization declines it and tells the model which authorization ended.",
  tags: ["hitl", "authorization", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.checkAccess, asAlice);
    expectHeld(held);
    const authorization = authorizationFrom(held);

    const steered = (await session.send(SAY.hello, asAlice)).expectOk();
    steered.notEvent("turn.started");
    steered.event("authorization.completed", {
      count: 1,
      data: {
        attemptId: authorization.attemptId,
        outcome: "declined",
        reason: "Cancelled because a new message arrived.",
      },
    });
    // The scripted model answers this way only when the authorization note reached it.
    steered.event("message.completed", { data: { message: REPLY.helloAfterAuthorization } });
    steered.notEvent("action.result", { data: { status: "completed" } });
  },
});
