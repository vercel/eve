import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { SAY, answers, asAlice, budgetQuestion, expectNoModelCallWhileOpen } from "../helpers.ts";

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

    const added = await session.start(SAY.deadline, asAlice);
    await added.waitForEvent("turn.paused");
    t.check(added.events.filter((event) => event.type === "model.started").length, equals(0));
    (await session.respond(answers("approve", request), asAlice)).expectOk();
    (await added.result()).expectOk();
    expectNoModelCallWhileOpen(session, request.interactionId);
  },
});
