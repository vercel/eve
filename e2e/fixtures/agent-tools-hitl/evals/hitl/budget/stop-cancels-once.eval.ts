import { defineEval } from "eve/evals";

import { answers, asAlice, budgetQuestion, expectResolved } from "../helpers.ts";

/** Alice chooses Stop: the question resolves once, and the turn is cancelled without a model call. */
export default defineEval({
  description: "Stop resolves the budget question once and cancels the turn.",
  tags: ["hitl", "budget", "cancel"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const stopped = await session.respond(answers("stop", request), asAlice);
    expectResolved(stopped, request, "accepted");
    stopped.event("interaction.settled", { count: 1 });
    stopped.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    stopped.notEvent("model.started");
    stopped.notEvent("content.completed");
    stopped.notEvent("turn.settled", { data: { outcome: "failed" } });
    session.event("interaction.settled", { count: 1, data: { interactionId: request.requestId } });
  },
});
