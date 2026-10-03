import { defineEval } from "eve/evals";

import { budgetQuestion, expectHeld, expectNoModelCallWhileOpen } from "../helpers.ts";

/**
 * Alice's session is out of output budget when she asks for a status note.
 * Before the model call, the turn asks whether to continue and holds: it
 * neither completes nor calls the model.
 */
export default defineEval({
  description: "Running out of budget before a model call asks the person and holds the turn.",
  tags: ["hitl", "human-input", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    const { held, request, session } = await budgetQuestion(t);
    expectHeld(held);
    held.event("input.requested", {
      count: 1,
      data: {
        requests: (requests) =>
          requests.length === 1 &&
          requests[0]?.kind === "session-limit" &&
          requests[0]?.requestId === request.requestId,
      },
    });
    held.notEvent("message.completed");
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
