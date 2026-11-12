import { defineEval } from "eve/evals";

import {
  ALICE,
  REPLY,
  SAY,
  aliceSession,
  asAlice,
  authorizationFrom,
  completeAuthorization,
  expectHeld,
  expectWaitsAsTask,
  follow,
  taskResultsReply,
} from "../helpers.ts";

/**
 * Alice's access check waits for her sign-in when she asks for a hello. Her message joins the
 * turn, and the sign-in stays open while the check waits as a task. Once she signs in, the check
 * runs as Alice and its result reaches the model before the turn ends.
 */
export default defineEval({
  description: "A message keeps a sign-in open, and its call runs as the caller once completed.",
  tags: ["hitl", "authorization", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.checkAccess, asAlice);
    expectHeld(held);
    const authorization = authorizationFrom(held);

    const joined = (await session.send(SAY.hello, asAlice)).expectOk();
    joined.notEvent("turn.started");
    expectWaitsAsTask(joined, { interactionId: authorization.attemptId });
    joined.notEvent("interaction.opened");
    joined.event("content.completed", { data: { phase: "reply", value: REPLY.hello } });

    const startIndex = session.state.streamIndex;
    await completeAuthorization(t, authorization.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "accepted" },
    });
    resumed.calledTool("auth-probe", { status: "completed", output: { actor: ALICE }, count: 1 });
    resumed.event("content.completed", {
      data: { phase: "reply", value: taskResultsReply([["auth-probe", "completed"]]) },
    });
    resumed.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
