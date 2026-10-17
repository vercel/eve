import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { REPLY, SAY, answers, asAlice, budgetQuestion } from "../helpers.ts";

/**
 * While the budget question waits, Alice adds that the note should mention
 * the deadline. Her message is admitted but not consumed, and does not answer
 * the question, so the turn stays held without calling the model; after
 * Continue the model reads it with her original request.
 *
 * `no-step-behind-budget.eval.ts` covers the stricter rule that no model run
 * even starts meanwhile.
 */
export default defineEval({
  description: "A message behind the budget question waits and is read after Continue.",
  tags: ["hitl", "budget", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const pending = await session.start(SAY.deadline, asAlice);
    await pending.waitForEvent("turn.paused");
    const added = { events: [...pending.events] };
    t.check(
      added.events.filter((event) =>
        [
          "delivery.consumed",
          "interaction.settled",
          "model.requested",
          "content.completed",
        ].includes(event.type),
      ).length,
      equals(0),
    );

    const resumed = (await session.respond(answers("approve", request), asAlice)).expectOk();
    resumed.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: SAY.deadline }] },
    });
    resumed.event("content.completed", {
      data: { phase: "reply", value: REPLY.statusNoteWithDeadline },
    });
    resumed.notEvent("turn.started");
    (await pending.result()).expectOk();
  },
});
