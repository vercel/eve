import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  completeAuthorization,
  follow,
  authorizationFrom,
} from "../helpers.ts";

/**
 * One step checks Alice's access (authorization) and asks to publish (approval).
 * Both use the same Fixture Auth sign-in. Approving the publish runs it, and
 * its authorization replaces the access check's open attempt, which fails as
 * superseded. Only the newer attempt's callback completes the authorization.
 */
export default defineEval({
  description: "A newer attempt at the same authorization supersedes the open one.",
  tags: ["hitl", "authorization"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.checkAndPublish, asAlice);
    const older = authorizationFrom(asked);
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
    const newer = authorizationFrom(superseded);
    if (newer.attemptId === older.attemptId)
      throw new Error("Expected a new authorization attempt.");

    const startIndex = session.state.streamIndex;
    await completeAuthorization(newer.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("authorization.completed", {
      count: 1,
      data: { attemptId: newer.attemptId, outcome: "authorized" },
    });
    resumed.notEvent("authorization.completed", { data: { attemptId: older.attemptId } });
  },
});
