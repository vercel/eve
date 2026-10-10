import { defineEval } from "eve/evals";

import { REPLY, SAY, answers, asAlice, budgetQuestion, expectHeld } from "../helpers.ts";

/**
 * While the budget question waits, Alice adds that the note should mention
 * the deadline. Her message is admitted but not consumed, and does not answer
 * the question, so the turn stays held without calling the model; after
 * Continue the model reads it with her original request.
 *
 * `no-step-behind-budget.eval.ts` covers the stricter rule that no model run
 * even starts meanwhile.
 */
export default defineEval({
  description: "A message behind the budget question waits and is read after Continue.",
  tags: ["hitl", "budget", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const added = await session.send(SAY.deadline, asAlice);
    added.notEvent("delivery.consumed");
    expectHeld(added);
    added.notEvent("interaction.settled");
    added.notEvent("model.requested");
    added.notEvent("content.completed");

    const resumed = (await session.respond(answers("continue", request), asAlice)).expectOk();
    resumed.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: SAY.deadline }] },
    });
    resumed.event("content.completed", {
      data: { phase: "reply", value: REPLY.statusNoteWithDeadline },
    });
    resumed.notEvent("turn.started");
  },
});
