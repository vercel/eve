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
    partial.notEvent("interaction.settled");
    partial.notEvent("model.started");
    partial.notEvent("call.settled");

    const finished = (await session.respond(answers("cancel", b), asAlice)).expectOk();
    // Both approvals settle in the one commit, each with its own answer.
    finished.event("interaction.settled", { count: 2 });
    finished.event("interaction.settled", {
      count: 1,
      data: { interactionId: a.requestId, outcome: "accepted" },
    });
    finished.event("interaction.settled", {
      count: 1,
      data: { interactionId: b.requestId, outcome: "declined" },
    });
    finished.eventsSatisfy("both approvals settle in one commit", (events) => {
      const lines = events.flatMap((event) =>
        event.type === "interaction.settled" ? [event.meta.position.line] : [],
      );
      return lines.length === 2 && lines[0] === lines[1];
    });
    finished.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectNotRun(finished, "change-b");
    finished.event("content.completed", {
      data: { phase: "reply", value: /^Change A: done .*\. Change B: not run\.$/u },
    });
    expectNoModelCallWhileOpen(session, a.requestId);
    expectNoModelCallWhileOpen(session, b.requestId);
  },
});
