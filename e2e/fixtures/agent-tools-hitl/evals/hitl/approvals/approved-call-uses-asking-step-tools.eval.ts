import { defineEval } from "eve/evals";

import { ALICE, SAY, aliceSession, answers, approvalFor, as, asAlice } from "../helpers.ts";

/**
 * The retiring change is a step-scoped dynamic tool that the fixture stops
 * offering for callers with the "retire" flag. Alice approves it with that
 * flag on: the approved call still runs, because eve runs it with the tools
 * of the step that asked, as its approval saw them.
 *
 * The opposite case — the tool is gone from the deployment by the time the
 * answer arrives, which fails with "The approved tool is no longer
 * available" — needs a redeploy between the ask and the answer, so local
 * e2e cannot reach it.
 */
export default defineEval({
  description: "An approved call runs with the tools of the step that asked for it.",
  tags: ["hitl", "approval", "dynamic-tools"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.retiring, asAlice), "retiring-change");

    const approved = (
      await session.respond(answers("approve", request), as(ALICE, "retire"))
    ).expectOk();
    approved.calledTool("retiring-change", {
      status: "completed",
      output: { change: "retiring" },
      count: 1,
    });
    approved.event("content.completed", {
      data: { phase: "reply", value: /^Retiring change: done / },
    });
  },
});
