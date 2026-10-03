import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  completeSignIn,
  follow,
  signInFrom,
} from "../helpers.ts";

/**
 * One step checks Alice's access (sign-in) and asks to publish (approval).
 * Both use the same Fixture Auth sign-in. Approving the publish runs it, and
 * its sign-in replaces the access check's open attempt, which fails as
 * superseded. Only the newer attempt's callback completes the sign-in.
 */
export default defineEval({
  description: "A newer attempt at the same sign-in supersedes the open one.",
  tags: ["hitl", "human-input", "sign-in"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.checkAndPublish, asAlice);
    const older = signInFrom(asked);
    const request = approvalFor(asked, "publish-draft");

    const superseded = await session.respond(answers("approve", request), asAlice);
    superseded.event("authorization.completed", {
      count: 1,
      data: {
        attemptId: older.attemptId,
        outcome: "failed",
        reason: "Superseded by a newer authorization attempt.",
      },
    });
    const newer = signInFrom(superseded);
    if (newer.attemptId === older.attemptId) throw new Error("Expected a new sign-in attempt.");

    const startIndex = session.state.streamIndex;
    await completeSignIn(newer.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("authorization.completed", {
      count: 1,
      data: { attemptId: newer.attemptId, outcome: "authorized" },
    });
    resumed.notEvent("authorization.completed", { data: { attemptId: older.attemptId } });
  },
});
