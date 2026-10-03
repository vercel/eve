import { defineEval } from "eve/evals";

import { REPLY, answers, asAlice, budgetQuestion, expectResolved } from "../helpers.ts";

/**
 * Alice chooses Continue. That grants a fresh budget window, and the model
 * call the budget stopped runs in the same turn.
 */
export default defineEval({
  description: "Continue grants a fresh budget and runs the stopped model call in the same turn.",
  tags: ["hitl", "human-input", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    const { held, request, session } = await budgetQuestion(t);
    const turnId = held.events.find((event) => event.type === "turn.started")?.data.turnId;

    const resumed = (await session.respond(answers("continue", request), asAlice)).expectOk();
    expectResolved(resumed, request, "answered");
    resumed.notEvent("turn.started");
    resumed.eventOrder([
      { type: "input.resolved" },
      { type: "step.started", data: { turnId } },
      { type: "message.completed", data: { message: REPLY.statusNote, turnId } },
      { type: "turn.completed", data: { turnId } },
    ]);
  },
});
