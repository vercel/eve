import { defineEval } from "eve/evals";

import { waitForRelayed } from "./helpers";

/**
 * The budget child runs out of budget mid-task and its question reaches
 * Alice through her session. She chooses Stop: the answer goes to the child,
 * and because Stop means stop, her own turn is cancelled too.
 */
export default defineEval({
  description: "Stop on a child's relayed budget question also cancels the parent's turn.",
  tags: ["hitl", "relayed", "budget"],
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send("RELAY-budget-child Alice records the release step.");
    const { request, session } = await waitForRelayed(
      t,
      started.session,
      "session_limit_continuation",
    );
    if (request.requestId.startsWith(`${session.sessionId}:`)) {
      throw new Error("Expected the child's budget question, not the parent's.");
    }

    const stopped = await session.respond([{ optionId: "stop", requestId: request.requestId }]);
    stopped.event("interaction.settled", {
      count: 1,
      data: {
        interactionId: request.requestId,
        outcome: "declined",
        response: { optionId: "stop" },
      },
    });
    stopped.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    stopped.notEvent("turn.settled", { data: { outcome: "failed" } });
    stopped.notEvent("content.completed", { data: { phase: "reply", value: /RELAY-RESULT/u } });
  },
});
