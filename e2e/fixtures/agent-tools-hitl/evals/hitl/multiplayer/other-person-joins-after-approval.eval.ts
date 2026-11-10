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
 * Alice's change waits for her approval when Bob asks for a status update. Bob's message waits
 * for the pause to end and then joins Alice's turn: her approval runs the change, and the model
 * reads Bob's message before the turn ends.
 */
export default defineEval({
  description: "Someone else's message joins the turn once its approval settles.",
  tags: ["hitl", "approval", "steer", "multiplayer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    await session.start(SAY.bobStatus, asBob);
    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    expectResolved(approved, request, "accepted");
    approved.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("turn.started");
    approved.eventOrder([
      { type: "call.settled", data: { callId: request.call?.callId, outcome: "completed" } },
      { type: "delivery.consumed", data: { parts: [{ kind: "text", text: SAY.bobStatus }] } },
      { type: "content.completed", data: { phase: "reply", value: REPLY.bobStatus } },
      { type: "turn.settled", data: { outcome: "completed" } },
    ]);
    approved.event("turn.settled", { count: 1 });
  },
});
