import { defineEval } from "eve/evals";

import { next, waitForRelayed } from "./helpers";

/**
 * Alice cancels her turn while the question child waits on her answer. The
 * cancelled agent task ends and withdraws its pending relayed question before
 * the parent turn settles, so nobody can answer it.
 */
export default defineEval({
  description: "Cancelling the parent's turn withdraws a child's relayed question.",
  tags: ["hitl", "relayed", "cancel"],
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send("RELAY-question-child Alice asks where the release should go.");
    const { request, session } = await waitForRelayed(t, started.session, "ask_question");

    const following = next(t, session);
    await session.cancel();
    const cancelled = await following;
    cancelled.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.interactionId, outcome: "withdrawn", reason: "asker-ended" },
    });
    cancelled.event("task.ended", { count: 1, data: { outcome: "cancelled" } });
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelled.eventOrder([
      {
        type: "interaction.settled",
        data: { interactionId: request.interactionId, outcome: "withdrawn" },
      },
      { type: "task.ended", data: { outcome: "cancelled" } },
      { type: "turn.settled", data: { outcome: "cancelled" } },
    ]);
    if (
      cancelled.session.pendingInteractions.some(
        (pending) => pending.interactionId === request.interactionId,
      )
    ) {
      throw new Error("The ended child's question is still open on the parent.");
    }
  },
});
