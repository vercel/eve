import { defineEval } from "eve/evals";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";

/**
 * The `staged-deploy` schedule runs the held-turn script. A schedule's turn
 * pauses as any held turn does, but its held text is narration, so a channel
 * would post only the final reply.
 *
 * Schedule dispatch is a dev route, so deployed targets skip this eval.
 */
export default defineEval({
  description: "A schedule's held turn narrates its held text and posts only its final reply.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    const dispatch = await t.target.dispatchSchedule("staged-deploy");
    const sessionId = dispatch.sessionIds[0];
    if (sessionId === undefined) throw new Error("The schedule started no session.");

    const session = await t.target.attachSession(sessionId);
    session.succeeded();
    session.event("content.completed", {
      count: 1,
      data: { kind: "text", phase: "narration", value: STAGE_INTERIM_MESSAGE },
    });
    session.event("content.completed", {
      count: 1,
      data: { kind: "text", phase: "reply", value: /^WORKFLOW-STAGE-RESULT / },
    });
    session.event("turn.paused", { count: 1 });
    session.event("call.settled", { count: 1, data: { callId: "stage", outcome: "completed" } });
    session.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
