import { defineEval } from "eve/evals";

import { SAY, aliceSession, approvalFor, asAlice, expectResolved } from "../helpers.ts";

/**
 * Alice answers her waiting change by typing "approve" instead of pressing the
 * button. The reply names the approval's option, so it answers it: the change
 * runs in the same turn, and the model never reads "approve" as a new request.
 */
export default defineEval({
  description: "A typed reply naming an approval's option answers it.",
  tags: ["hitl", "approval", "text-reply"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const typed = (await session.send("approve", asAlice)).expectOk();
    expectResolved(typed, request, "approved");
    typed.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    typed.notEvent("turn.started");
    typed.event("message.completed", { data: { message: /^Change A: done / } });
    typed.event("turn.completed", { count: 1 });
  },
});
