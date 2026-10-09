import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectNotRun,
} from "../helpers.ts";

/**
 * Alice approves change A from a pair, then changes her mind and asks for a
 * hello instead. Her message steers the held turn: B, which nobody answered,
 * is ignored and never runs; A keeps her approval and runs; the model reads
 * her message in the same turn.
 */
export default defineEval({
  description: "Steering past approvals ignores unanswered ones and keeps the answers given.",
  tags: ["hitl", "approval", "partial-approval", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changesAB, asAlice);
    const a = approvalFor(asked, "change-a");
    const b = approvalFor(asked, "change-b");
    await session.respond(answers("approve", a), asAlice);

    const steered = (await session.send(SAY.hello, asAlice)).expectOk();
    steered.event("interaction.settled", {
      count: 1,
      data: { interactionId: a.requestId, outcome: "accepted" },
    });
    steered.event("interaction.settled", {
      count: 1,
      data: { interactionId: b.requestId, outcome: "withdrawn" },
    });
    steered.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectNotRun(steered, "change-b");
    steered.event("call.settled", {
      data: {
        callId: b.action.callId,
        outcome: "rejected",
        output: { approval: { status: "ignored" } },
      },
    });
    steered.notEvent("turn.started");
    steered.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: SAY.hello }] },
    });
    // The answers settle first. A runs before the model's next run; Alice's
    // message is consumed into the same turn before the run after that.
    steered.eventOrder([
      { type: "interaction.settled" },
      { type: "call.settled", data: { callId: a.action.callId, outcome: "completed" } },
      { type: "delivery.consumed", data: { parts: [{ kind: "text", text: SAY.hello }] } },
      { type: "model.started" },
      { type: "content.completed", data: { phase: "reply", value: REPLY.hello } },
      { data: { outcome: "completed" }, type: "turn.settled" },
    ]);
  },
});
