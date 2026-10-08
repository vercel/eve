import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  expectResolved,
} from "../helpers.ts";

/**
 * Alice's change waits for her approval when Bob asks for a status update.
 * Only Alice's own message steers her turn: Bob's waits for the turn to end,
 * so Alice's approval still runs the change, and Bob's message runs next.
 */
export default defineEval({
  description: "A message from someone else waits for the held turn to end instead of steering it.",
  tags: ["hitl", "approval", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const bob = await session.start(SAY.bobStatus, asBob);
    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    expectResolved(approved, request, "approved");
    approved.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("message.received", { data: { message: SAY.bobStatus } });

    approved.event("message.completed", { data: { message: /^Change A: done / } });
    approved.event("turn.completed", { count: 1 });

    // Bob's message starts its own turn once Alice's has ended.
    const bobTurn = (await bob.result()).expectOk();
    bobTurn.eventOrder([
      { type: "turn.started" },
      { type: "message.received", data: { message: SAY.bobStatus } },
      { type: "message.completed", data: { message: REPLY.bobStatus } },
      { type: "turn.completed" },
    ]);
    bobTurn.notEvent("input.resolved");
  },
});
