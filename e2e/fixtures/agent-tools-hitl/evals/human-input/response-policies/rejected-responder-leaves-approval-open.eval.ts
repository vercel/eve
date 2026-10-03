import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  expectHeld,
  expectNoModelCallWhileOpen,
} from "../helpers.ts";

/**
 * Only the release manager may approve the authorized change. Bob approves
 * it anyway: his answer becomes a candidate the policy rejects, and the
 * approval stays open with the turn held.
 */
export default defineEval({
  description: "A response policy rejects an unauthorized answer and the approval stays open.",
  tags: ["hitl", "human-input", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.authorized, asAlice), "authorized-change");

    const refused = await session.respond(answers("approve", request), asBob);
    expectHeld(refused);
    refused.eventOrder([
      { type: "approval.candidate", data: { outcome: "pending", responderPrincipalId: "bob" } },
      {
        type: "approval.candidate",
        data: { outcome: "rejected", reason: "Wrong responder.", responderPrincipalId: "bob" },
      },
      { type: "turn.waiting", data: { on: "input" } },
    ]);
    refused.notEvent("approval.settled");
    refused.notEvent("input.resolved");
    refused.notEvent("action.result");
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
