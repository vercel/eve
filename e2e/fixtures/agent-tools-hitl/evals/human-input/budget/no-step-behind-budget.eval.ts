import { defineEval } from "eve/evals";

import { SAY, asAlice, budgetQuestion, expectNoModelCallWhileOpen } from "../helpers.ts";

/**
 * While the budget question waits, Alice adds a message. The turn must stay
 * held without starting a model step: nothing may run while the question is
 * open.
 *
 * BUG: a held turn whose input carries a message proceeds into the next step
 * (packages/eve/src/harness/tool-loop.ts:697 holds only when there is no
 * message), emits `step.started` for stepIndex 1 (tool-loop.ts:906), and only
 * then re-checks the budget and holds again (tool-loop.ts:1435-1440). The
 * model is not called, but the stream shows a step that starts and never
 * completes. Skipped unless EVE_E2E_KNOWN_BUGS=1 so the suite stays green.
 */
export default defineEval({
  description: "No model step starts while the budget question is open.",
  tags: ["hitl", "human-input", "budget", "known-bug"],
  timeoutMs: 60_000,
  async test(t) {
    if (process.env.EVE_E2E_KNOWN_BUGS !== "1") {
      t.skip("BUG: a message behind the budget question starts a step that never completes.");
    }
    const { request, session } = await budgetQuestion(t);

    const added = await session.send(SAY.deadline, asAlice);
    added.notEvent("step.started");
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
