import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectHeld,
  expectNoModelCallWhileOpen,
  expectNotRun,
} from "../helpers.ts";

/**
 * One step asks Alice to approve changes A and B. Her answer to A alone waits
 * in the turn: nothing resolves, nothing runs, and the model is not called.
 * Declining B then resolves both together, each with its own answer.
 */
export default defineEval({
  description: "A partial answer keeps the turn held until every approval of the step is answered.",
  tags: ["hitl", "approval", "partial-approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changesAB, asAlice);
    const a = approvalFor(asked, "change-a");
    const b = approvalFor(asked, "change-b");

    const partial = await session.respond(answers("approve", a), asAlice);
    expectHeld(partial);
    partial.notEvent("input.resolved");
    partial.notEvent("step.started");
    partial.notEvent("action.result");

    const finished = (await session.respond(answers("cancel", b), asAlice)).expectOk();
    finished.event("input.resolved", {
      count: 1,
      data: {
        resolutions: (items) =>
          items.length === 2 &&
          items.some((item) => item.requestId === a.requestId && item.outcome === "approved") &&
          items.some((item) => item.requestId === b.requestId && item.outcome === "denied"),
      },
    });
    finished.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectNotRun(finished, "change-b");
    finished.event("message.completed", {
      data: { message: /^Change A: done .*\. Change B: not run\.$/u },
    });
    expectNoModelCallWhileOpen(session, a.requestId);
    expectNoModelCallWhileOpen(session, b.requestId);
  },
});
