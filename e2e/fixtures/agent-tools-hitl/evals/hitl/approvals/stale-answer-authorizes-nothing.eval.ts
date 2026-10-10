import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  approvalFor,
  asAlice,
  expectNotRun,
  expectResolved,
} from "../helpers.ts";

/**
 * While change A waits, Alice's client submits "approve" for a request that
 * is not open (an old prompt). That answer becomes a message the model reads:
 * it steers the turn like any message, so it authorizes nothing, A included.
 */
export default defineEval({
  description: "An answer to a request that is not open becomes a message and authorizes nothing.",
  tags: ["hitl", "approval", "stale-response"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const stale = (
      await session.respond([{ optionId: "approve", requestId: "an-earlier-prompt" }], asAlice)
    ).expectOk();
    expectResolved(stale, request, "withdrawn");
    expectNotRun(stale, "change-a");
    // The answer reaches the model as a note about an earlier prompt, never as Alice's text.
    stale.event("delivery.consumed", { count: 1, data: { parts: [] } });
    stale.event("content.completed", { data: { phase: "reply", value: REPLY.staleAnswer } });
    stale.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
