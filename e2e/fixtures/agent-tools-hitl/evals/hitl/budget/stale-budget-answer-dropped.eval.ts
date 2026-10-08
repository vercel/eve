import { defineEval } from "eve/evals";

import { REPLY, SAY, answers, asAlice, budgetQuestion } from "../helpers.ts";

/**
 * Alice's client sends her Continue a second time after the question closed.
 * A late budget answer must be dropped, not read as a message: read as text,
 * a late Stop would seem to stop something. Her next message then runs as
 * usual, with nothing stale before it.
 */
export default defineEval({
  description: "An answer to a budget question that already closed is dropped.",
  tags: ["hitl", "budget", "stale-response"],
  timeoutMs: 60_000,
  async test(t) {
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
