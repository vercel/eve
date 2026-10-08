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

export default defineEval({
  description: "Approval supplies consent, not the responder's release access.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.callerAccess, asAlice), "caller-access");
    const approved = (await session.respond(answers("approve", request), asBob)).expectOk();
    expectResolved(approved, request, "approved");
    approved.event("approval.settled", {
      data: { responderPrincipalId: "bob", outcome: "approved" },
    });
    approved.event("action.result", {
      count: 1,
      data: { result: { toolName: "caller-access", output: { actor: "alice", allowed: false } } },
    });
  },
});
