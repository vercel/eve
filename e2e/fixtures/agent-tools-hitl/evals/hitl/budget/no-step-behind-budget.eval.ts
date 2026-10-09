import { defineEval } from "eve/evals";

import { SAY, asAlice, budgetQuestion, expectNoModelCallWhileOpen } from "../helpers.ts";

/**
 * While the budget question waits, Alice adds a message. The turn must stay
 * held without starting a model step: nothing may run while the question is
 * open.
 */
export default defineEval({
  description: "No model step starts while the budget question is open.",
  tags: ["hitl", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const added = await session.send(SAY.deadline, asAlice);
    added.notEvent("model.started");
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
