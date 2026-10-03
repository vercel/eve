import { defineEval } from "eve/evals";

import { budgetQuestion, expectResolved, follow } from "../helpers.ts";

/** Alice cancels her turn while the budget question waits: it closes unanswered, as cancelled. */
export default defineEval({
  description: "Cancelling the turn withdraws its budget question.",
  tags: ["hitl", "human-input", "budget", "cancel"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);
    const startIndex = session.state.streamIndex;

    await session.cancel();
    const cancelled = await follow(t, session, startIndex);
    expectResolved(cancelled, request, "cancelled");
    cancelled.event("input.resolved", { count: 1 });
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.notEvent("step.started");
  },
});
