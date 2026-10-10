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
 * One step checks Alice's access (a sign-in) and asks to publish (an approval).
 * Both use the same Fixture Auth sign-in. Approving the publish runs it, and
 * its sign-in replaces the access check's open one, which is abandoned as
 * superseded. Only the newer sign-in's callback completes it.
 */
export default defineEval({
  description: "A newer attempt at the same sign-in supersedes the open one.",
  tags: ["hitl", "authorization"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.checkAndPublish, asAlice);
    const older = authorizationFrom(asked);
    const request = approvalFor(asked, "publish-draft");
    // The sign-in beside the approval: one pause waits on both.
    asked.event("turn.paused", {
      count: 1,
      data: {
        awaiting: (awaiting) =>
          [older.attemptId, request.requestId].every((id) =>
            awaiting.some((entry) => "interactionId" in entry && entry.interactionId === id),
          ),
      },
    });

    const superseded = await session.respond(answers("approve", request), asAlice);
    superseded.event("interaction.settled", {
      count: 1,
      data: {
        interactionId: older.attemptId,
        outcome: "abandoned",
        reason: "Superseded by a newer authorization attempt.",
      },
    });
    const newer = authorizationFrom(superseded);
    if (newer.attemptId === older.attemptId) throw new Error("Expected a new sign-in.");

    const startIndex = session.state.streamIndex;
    await completeAuthorization(newer.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: newer.attemptId, outcome: "accepted" },
    });
    resumed.notEvent("interaction.settled", { data: { interactionId: older.attemptId } });
  },
});
