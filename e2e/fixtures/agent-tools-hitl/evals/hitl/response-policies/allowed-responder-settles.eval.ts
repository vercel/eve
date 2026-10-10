import { defineEval } from "eve/evals";

import {
  RELEASE_MANAGER,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asReleaseManager,
  expectResolved,
} from "../helpers.ts";

/**
 * The release manager approves Alice's authorized change. The policy allows
 * the candidate, which settles the approval as the release manager's; the
 * change then runs once.
 */
export default defineEval({
  description: "An answer the response policy allows settles the approval and runs the call.",
  tags: ["hitl", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.authorized, asAlice), "authorized-change");

    const settled = (
      await session.respond(answers("approve", request), asReleaseManager)
    ).expectOk();
    // The release manager's delivery carries the answer; the policy applies it.
    settled.eventOrder([
      { type: "delivery.admitted", data: { principal: { id: RELEASE_MANAGER } } },
      { type: "response.submitted", data: { interactionId: request.requestId } },
      { type: "response.settled", data: { outcome: "applied" } },
      {
        type: "interaction.settled",
        data: { interactionId: request.requestId, outcome: "accepted" },
      },
      { type: "call.settled", data: { callId: request.action.callId, outcome: "completed" } },
      { data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    expectResolved(settled, request, "accepted");
    settled.calledTool("authorized-change", {
      status: "completed",
      output: { executions: 1 },
      count: 1,
    });
  },
});
