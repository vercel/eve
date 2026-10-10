import { defineEval } from "eve/evals";
import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  expectResolved,
} from "../helpers.ts";

/**
 * Bob approves Alice's release-access check. His answer supplies consent, not his access: the
 * call runs as Alice, the requester, and reports her access.
 */
export default defineEval({
  description: "Approval supplies consent, not the responder's release access.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.callerAccess, asAlice), "caller-access");
    const approved = (await session.respond(answers("approve", request), asBob)).expectOk();
    expectResolved(approved, request, "accepted");
    approved.eventOrder([
      { type: "delivery.admitted", data: { principal: { id: "bob" } } },
      { type: "response.submitted", data: { interactionId: request.requestId } },
      {
        type: "interaction.settled",
        data: { interactionId: request.requestId, outcome: "accepted" },
      },
    ]);
    approved.calledTool("caller-access", {
      count: 1,
      output: { actor: "alice", allowed: false },
      status: "completed",
    });
  },
});
