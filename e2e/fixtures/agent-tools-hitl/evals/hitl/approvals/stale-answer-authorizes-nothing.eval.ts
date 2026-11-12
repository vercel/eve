import { defineEval } from "eve/evals";

import { REPLY, SAY, aliceSession, approvalFor, asAlice, expectWaitsAsTask } from "../helpers.ts";

/**
 * While change A waits, Alice's client submits "approve" for a request that
 * is not open (an old prompt). That answer becomes a message the model reads:
 * it joins the turn like any message, so it authorizes nothing. A's approval
 * stays open, and its call waits as a task.
 */
export default defineEval({
  description: "An answer to a request that is not open becomes a message and authorizes nothing.",
  tags: ["hitl", "approval", "stale-response"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const stale = (
      await session.respond([{ optionId: "approve", interactionId: "an-earlier-prompt" }], asAlice)
    ).expectOk();
    expectWaitsAsTask(stale, request);
    stale.calledTool("change-a", { count: 0, status: "completed" });
    // The answer reaches the model as a note about an earlier prompt, never as Alice's text.
    stale.event("delivery.consumed", { count: 1, data: { parts: [] } });
    stale.event("content.completed", { data: { phase: "reply", value: REPLY.staleAnswer } });
  },
});
