import { defineEval } from "eve/evals";

import { REPLY, asAlice, budgetQuestion, expectResolved } from "../helpers.ts";

/** Alice types "continue": it names the question's option, so it answers it like the button. */
export default defineEval({
  description: "A typed reply naming a budget option answers the budget question.",
  tags: ["hitl", "human-input", "budget", "text-reply"],
  timeoutMs: 60_000,
  async test(t) {
    const { request, session } = await budgetQuestion(t);

    const typed = (await session.send("continue", asAlice)).expectOk();
    expectResolved(typed, request, "answered");
    typed.event("input.resolved", {
      data: { resolutions: [{ requestId: request.requestId, response: { optionId: "continue" } }] },
    });
    typed.notEvent("turn.started");
    typed.event("message.completed", { data: { message: REPLY.statusNote } });
  },
});
