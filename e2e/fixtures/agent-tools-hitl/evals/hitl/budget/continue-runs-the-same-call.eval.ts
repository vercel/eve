import { defineEval } from "eve/evals";

import { REPLY, answers, asAlice, budgetQuestion, expectResolved } from "../helpers.ts";

/**
 * Alice chooses Continue. That grants a fresh budget window, and the model
 * call the budget stopped runs in the same turn.
 */
export default defineEval({
  description: "Continue grants a fresh budget and runs the stopped model call in the same turn.",
  tags: ["hitl", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    const { held, request, session } = await budgetQuestion(t);
    const turnId = held.events.find((event) => event.type === "turn.started")?.data.turnId;

    const resumed = (await session.respond(answers("continue", request), asAlice)).expectOk();
    expectResolved(resumed, request, "accepted");
    resumed.notEvent("turn.started");
    resumed.eventOrder([
      { type: "interaction.settled", data: { interactionId: request.requestId } },
      { type: "model.requested", data: { owner: { turnId } } },
      { type: "content.completed", data: { phase: "reply", value: REPLY.statusNote } },
      { type: "turn.settled", data: { outcome: "completed", turnId } },
    ]);
  },
});
