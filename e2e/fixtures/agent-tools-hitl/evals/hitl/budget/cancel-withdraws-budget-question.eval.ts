import { defineEval } from "eve/evals";

import { budgetQuestion, follow } from "../helpers.ts";

/** Alice cancels her turn while the budget question waits: it closes unanswered. */
export default defineEval({
  description: "Cancelling the turn withdraws its budget question.",
  tags: ["hitl", "budget", "cancel"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);
    const startIndex = session.state.streamIndex;

    await session.cancel();
    const cancelled = await follow(t, session, startIndex);
    // The cancel interrupts the question; nobody answered it.
    cancelled.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.requestId, outcome: "interrupted" },
    });
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelled.notEvent("model.requested");
  },
});
