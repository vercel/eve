import { defineEval } from "eve/evals";

import { SAY, aliceSession, answers, approvalFor, asAlice } from "../helpers.ts";

/**
 * `guarded-echo` uses `once()`. Alice approves the first echo; the grant lasts
 * the session, so her second echo runs without asking again.
 */
export default defineEval({
  description: "A once() approval grants its key for the rest of the session.",
  tags: ["hitl", "approval", "once"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const first = approvalFor(await session.send(SAY.firstEcho, asAlice), "guarded-echo");
    (await session.respond(answers("approve", first), asAlice))
      .expectOk()
      .calledTool("guarded-echo", { status: "completed", count: 1 });

    const second = (await session.send(SAY.secondEcho, asAlice)).expectOk();
    second.notEvent("interaction.opened");
    second.calledTool("guarded-echo", {
      status: "completed",
      output: { echoed: "second" },
      count: 1,
    });
    second.event("content.completed", { data: { phase: "reply", value: /^Second echo: done / } });
  },
});
