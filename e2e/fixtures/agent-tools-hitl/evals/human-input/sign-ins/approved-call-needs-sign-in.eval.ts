import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  completeSignIn,
  expectHeld,
  expectResolved,
  follow,
  signInFrom,
} from "../helpers.ts";

/**
 * Publishing the draft needs approval (once) and a sign-in. Alice approves;
 * the approved call then asks her to sign in, which holds the turn. After the
 * callback the model calls publish again, the once() grant covers it, and it
 * runs as Alice.
 */
export default defineEval({
  description: "An approved call that needs a sign-in holds the turn and runs after it.",
  tags: ["hitl", "human-input", "approval", "sign-in"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.publish, asAlice), "publish-draft");

    const signing = await session.respond(answers("approve", request), asAlice);
    expectResolved(signing, request, "approved");
    expectHeld(signing);
    signing.event("authorization.required", { count: 1, data: { principalId: ALICE } });
    signing.notEvent("action.result", { data: { status: "completed" } });
    const signIn = signInFrom(signing);

    const startIndex = session.state.streamIndex;
    await completeSignIn(signIn.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("authorization.completed", {
      count: 1,
      data: { attemptId: signIn.attemptId, outcome: "authorized" },
    });
    resumed.notEvent("input.requested");
    resumed.calledTool("publish-draft", {
      status: "completed",
      output: { actor: ALICE, publications: 1 },
      count: 1,
    });
    resumed.event("message.completed", { data: { message: /^Publish: done / } });
  },
});
