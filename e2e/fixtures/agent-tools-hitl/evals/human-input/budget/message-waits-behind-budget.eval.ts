import { defineEval } from "eve/evals";

import { REPLY, SAY, answers, asAlice, budgetQuestion, expectHeld } from "../helpers.ts";

/**
 * While the budget question waits, Alice adds that the note should mention
 * the deadline. Her message is received at once but does not answer the
 * question, so the turn stays held without calling the model; after Continue
 * the model reads it with her original request.
 *
 * `no-step-behind-budget.eval.ts` covers the stricter rule that no step even
 * starts meanwhile, which this tip violates.
 */
export default defineEval({
  description: "A message behind the budget question is received at once and read after Continue.",
  tags: ["hitl", "human-input", "budget", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const added = await session.send(SAY.deadline, asAlice);
    added.event("message.received", { count: 1, data: { message: SAY.deadline } });
    expectHeld(added);
    added.notEvent("input.resolved");
    added.notEvent("step.completed");
    added.notEvent("message.completed");

    const resumed = (await session.respond(answers("continue", request), asAlice)).expectOk();
    resumed.event("message.completed", { data: { message: REPLY.statusNoteWithDeadline } });
    resumed.notEvent("turn.started");
  },
});
