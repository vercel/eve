import { defineEval } from "eve/evals";

import { STAGE_INTERIM_MESSAGE } from "../task-scenario-text";
import { HELD_TURN } from "./held-turn.shared";

/**
 * The `staged-deploy` schedule runs the held-turn script. A schedule's turn
 * shows no waiting boundary: the held text step reports `"tool-calls"`, so a
 * channel would post only the final reply.
 *
 * Schedule dispatch is a dev route, so deployed targets skip this eval.
 */
export default defineEval({
  description: "A schedule's held turn reports tool-calls and posts only its final reply.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; schedule dispatch is dev-only.");
    }

    const dispatch = await t.target.dispatchSchedule("staged-deploy");
    const sessionId = dispatch.sessionIds[0];
    if (sessionId === undefined) throw new Error("The schedule started no session.");

    const session = await t.target.attachSession(sessionId);
    session.succeeded();
    session.event("message.completed", {
      count: 1,
      data: { finishReason: "tool-calls", message: STAGE_INTERIM_MESSAGE },
    });
    session.event("message.completed", {
      count: 1,
      data: { finishReason: "stop", message: /^WORKFLOW-STAGE-RESULT / },
    });
    session.notEvent("session.waiting", { data: HELD_TURN });
    session.event("task.settled", { count: 1, data: { status: "completed" } });
    session.event("turn.completed", { count: 1 });
  },
});
