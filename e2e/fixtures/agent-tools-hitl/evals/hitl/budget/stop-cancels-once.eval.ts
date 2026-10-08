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
    expectResolved(stopped, request, "answered");
    stopped.event("input.resolved", { count: 1 });
    stopped.event("turn.cancelled", { count: 1 });
    stopped.notEvent("step.started");
    stopped.notEvent("message.completed");
    stopped.notEvent("turn.failed");
    session.event("input.resolved", {
      count: 1,
      data: { resolutions: (items) => items.some((item) => item.requestId === request.requestId) },
    });
  },
});
