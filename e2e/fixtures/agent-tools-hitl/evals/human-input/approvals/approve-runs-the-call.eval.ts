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
  tags: ["hitl", "human-input", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const held = await session.send(SAY.changeA, asAlice);
    expectHeld(held);
    const request = approvalFor(held, "change-a");

    const approved = (await session.respond(answers("approve", request), asAlice)).expectOk();
    expectResolved(approved, request, "approved");
    approved.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("turn.started");
    approved.eventOrder([
      { type: "input.resolved" },
      { type: "action.result", data: { status: "completed", result: { toolName: "change-a" } } },
      { type: "step.started" },
      { type: "message.completed", data: { message: /^Change A: done / } },
      { type: "turn.completed" },
    ]);
    expectNoModelCallWhileOpen(session, request.requestId);
  },
});
