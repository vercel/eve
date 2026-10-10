import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectHeld,
  expectNoModelCallWhileOpen,
  expectResolved,
} from "../helpers.ts";

/**
 * Alice asks for change A and approves it. eve runs the call itself, so its
 * result lands before the model's next step, and the model's history never
 * carries an AI SDK approval part (the scripted model fails the turn if it does).
 */
export default defineEval({
  description: "Approving a call runs it in eve, before the model's next step.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.changeA, asAlice);
    expectHeld(held);
    const request = approvalFor(held, "change-a");

    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    expectResolved(approved, request, "accepted");
    approved.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("turn.started");
    // eve runs the approved call before the model's next run starts.
    approved.eventOrder([
      { type: "interaction.settled", data: { interactionId: request.requestId } },
      { type: "call.settled", data: { callId: request.action.callId, outcome: "completed" } },
      { type: "model.started" },
      { type: "content.completed", data: { phase: "reply", value: /^Change A: done / } },
      { data: { outcome: "completed" }, type: "turn.settled" },
    ]);
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
