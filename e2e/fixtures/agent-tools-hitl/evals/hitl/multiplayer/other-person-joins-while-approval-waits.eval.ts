import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  bobSteers,
  expectResolved,
  expectWaitsAsTask,
  taskResultsReply,
} from "../helpers.ts";

/**
 * Alice's change waits for her approval when Bob asks for a status update. Bob's message joins
 * Alice's turn at once: the model answers him while the change waits as a task. Alice's approval
 * then runs the change as hers, and its result reaches the model before the turn ends.
 */
export default defineEval({
  description: "Someone else's message joins the turn while its approval waits.",
  tags: ["hitl", "approval", "steer", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const joined = (await session.send(SAY.bobStatus, bobSteers)).expectOk();
    joined.notEvent("turn.started");
    expectWaitsAsTask(joined, request);
    joined.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: SAY.bobStatus }] },
    });
    joined.event("content.completed", { data: { phase: "reply", value: REPLY.bobStatus } });

    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    expectResolved(approved, request, "accepted");
    approved.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("turn.started");
    approved.eventOrder([
      { type: "call.settled", data: { callId: request.call?.callId, outcome: "completed" } },
      {
        type: "content.completed",
        data: { phase: "reply", value: taskResultsReply([["change-a", "completed"]]) },
      },
      { type: "turn.settled", data: { outcome: "completed" } },
    ]);
  },
});
