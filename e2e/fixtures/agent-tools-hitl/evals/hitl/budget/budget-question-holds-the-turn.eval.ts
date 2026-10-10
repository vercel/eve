import { defineEval } from "eve/evals";

import { budgetQuestion, expectHeld, expectNoModelCallWhileOpen } from "../helpers.ts";

/**
 * Alice's session is out of output budget when she asks for a status note.
 * Before the model call, the turn asks whether to continue and holds: it
 * neither settles nor calls the model.
 */
export default defineEval({
  description: "Running out of budget before a model call asks the person and holds the turn.",
  tags: ["hitl", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    const { held, request, session } = await budgetQuestion(t);
    expectHeld(held);
    held.event("interaction.opened", {
      count: 1,
      data: { interactionId: request.requestId, request: { kind: "budget" } },
    });
    held.notEvent("content.completed", { data: { phase: "reply" } });
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
