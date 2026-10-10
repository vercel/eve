import { defineEval } from "eve/evals";

import { next, waitForRelayed } from "./helpers";

/**
 * Alice cancels her turn while the question child waits on her answer. The
 * cancel stops the child, so nobody can answer its question: the parent
 * withdraws it as cancelled.
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
      data: { interactionId: request.requestId, outcome: "interrupted" },
    });
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
  },
});
