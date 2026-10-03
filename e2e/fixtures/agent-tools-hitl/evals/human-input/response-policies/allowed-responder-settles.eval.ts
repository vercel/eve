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
  tags: ["hitl", "human-input", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.authorized, asAlice), "authorized-change");

    const settled = (
      await session.respond(answers("approve", request), asReleaseManager)
    ).expectOk();
    settled.eventOrder([
      { type: "approval.candidate", data: { outcome: "pending", requestId: request.requestId } },
      {
        type: "approval.settled",
        data: {
          outcome: "approved",
          requestId: request.requestId,
          responderPrincipalId: RELEASE_MANAGER,
        },
      },
      { type: "input.resolved" },
      {
        type: "action.result",
        data: { status: "completed", result: { toolName: "authorized-change" } },
      },
      { type: "turn.completed" },
    ]);
    expectResolved(settled, request, "approved");
    settled.calledTool("authorized-change", {
      status: "completed",
      output: { executions: 1 },
      count: 1,
    });
  },
});
