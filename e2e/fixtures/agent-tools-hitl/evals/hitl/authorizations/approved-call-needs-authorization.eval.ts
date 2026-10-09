import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  completeAuthorization,
  expectHeld,
  expectResolved,
  follow,
  authorizationFrom,
} from "../helpers.ts";

/**
 * Publishing the draft needs approval (once) and an authorization. Alice approves;
 * the approved call then asks her to authorize, which holds the turn. After the
 * callback the model calls publish again, the once() grant covers it, and it
 * runs as Alice.
 */
export default defineEval({
  description: "An approved call that needs an authorization holds the turn and runs after it.",
  tags: ["hitl", "approval", "authorization"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.publish, asAlice), "publish-draft");

    const signing = await session.respond(answers("approve", request), asAlice);
    expectResolved(signing, request, "accepted");
    expectHeld(signing);
    signing.event("interaction.opened", {
      count: 1,
      data: { audience: { principalIds: [ALICE] }, request: { kind: "sign-in" } },
    });
    signing.notEvent("call.settled", { data: { outcome: "completed" } });
    const authorization = authorizationFrom(signing);

    const startIndex = session.state.streamIndex;
    await completeAuthorization(authorization.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: authorization.attemptId, outcome: "accepted" },
    });
    resumed.notEvent("interaction.opened");
    resumed.calledTool("publish-draft", {
      status: "completed",
      output: { actor: ALICE, publications: 1 },
      count: 1,
    });
    resumed.event("content.completed", { data: { phase: "reply", value: /^Publish: done / } });
  },
});
