import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  asAlice,
  completeAuthorization,
  expectHeld,
  expectNoModelCallDuringAuthorization,
  follow,
  authorizationFrom,
} from "../helpers.ts";

/**
 * Alice's access check needs a Fixture Auth sign-in, which holds her turn.
 * The callback is an anonymous browser request, yet the turn resumes as
 * Alice: the tool runs again with her identity, in the same turn.
 */
export default defineEval({
  description:
    "A tool's authorization holds the turn, and its callback resumes it as the requester.",
  tags: ["hitl", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.checkAccess, asAlice);
    expectHeld(held);
    held.event("interaction.opened", {
      count: 1,
      data: { audience: { principalIds: [ALICE] }, request: { kind: "sign-in" } },
    });
    held.notEvent("interaction.settled");
    const authorization = authorizationFrom(held);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(authorization.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.notEvent("turn.started");
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "accepted" },
    });
    resumed.calledTool("auth-probe", {
      status: "completed",
      output: { actor: ALICE },
      count: 1,
    });
    resumed.event("content.completed", { data: { phase: "reply", value: /^Access check: done / } });
    expectNoModelCallDuringAuthorization(resumed, authorization.attemptId, held.events);
  },
});
