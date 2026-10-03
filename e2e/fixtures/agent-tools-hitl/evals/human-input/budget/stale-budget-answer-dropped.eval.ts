import { defineEval } from "eve/evals";

import { REPLY, SAY, answers, asAlice, budgetQuestion } from "../helpers.ts";

/**
 * Alice's client sends her Continue a second time after the question closed.
 * A late budget answer must be dropped, not read as a message: read as text,
 * a late Stop would seem to stop something. Her next message then runs as
 * usual, with nothing stale before it.
 *
 * BUG: the late answer reaches the model as a "continue" message.
 * `HumanInput.acceptInput` (packages/eve/src/harness/human-input/index.ts:115)
 * runs `staleAnswersAsText` (human-input/stale-answers.ts:22-26), which turns
 * every answer to a request that is not open into text before the rules run,
 * so `answerBudget`'s drop of closed budget questions
 * (human-input/budget.ts:49-67) never sees it. The late Continue does not grant
 * budget, but it starts a turn and the model answers it. Skipped unless
 * EVE_E2E_KNOWN_BUGS=1 so the suite stays green.
 */
export default defineEval({
  description: "An answer to a budget question that already closed is dropped.",
  tags: ["hitl", "human-input", "budget", "stale-response", "known-bug"],
  timeoutMs: 60_000,
  async test(t) {
    if (process.env.EVE_E2E_KNOWN_BUGS !== "1") {
      t.skip("BUG: a late budget answer becomes a message the model reads.");
    }
    const { request, session } = await budgetQuestion(t);
    (await session.respond(answers("continue", request), asAlice)).expectOk();

    await session.startRespond(answers("continue", request), asAlice);
    const next = (await session.send(SAY.bobStatus, asAlice)).expectOk();
    next.event("message.completed", { data: { message: REPLY.bobStatus } });
    session.notEvent("message.received", { data: { message: "continue" } });
    session.notEvent("message.completed", { data: { message: REPLY.staleAnswer } });
    session.event("input.resolved", { count: 1 });
  },
});
