import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectResolved,
  expectWaitsAsTask,
  taskResultsReply,
} from "../helpers.ts";

/**
 * Alice approves change A from a pair, then asks for a hello before she decides on B. Her message
 * joins the held turn: A keeps her approval and runs, B's approval stays open and its call waits
 * as a task, and the model reads A's result and her message. Her later approval runs B, and its
 * result reaches the model before the turn ends.
 */
export default defineEval({
  description: "A message keeps unanswered approvals open, and their calls run once approved.",
  tags: ["hitl", "approval", "partial-approval", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changesAB, asAlice);
    const a = approvalFor(asked, "change-a");
    const b = approvalFor(asked, "change-b");
    await session.respond(answers("approve", a), asAlice);

    const joined = (await session.send(SAY.hello, asAlice)).expectOk();
    expectResolved(joined, a, "accepted");
    joined.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectWaitsAsTask(joined, b);
    joined.notEvent("turn.started");
    joined.event("delivery.consumed", {
      count: 1,
      data: { parts: [{ kind: "text", text: SAY.hello }] },
    });
    // A runs before the model reads A's result and Alice's message.
    joined.eventOrder([
      { type: "call.settled", data: { callId: a.call?.callId, outcome: "completed" } },
      { type: "model.started" },
      { type: "content.completed", data: { phase: "reply", value: REPLY.hello } },
      { type: "turn.paused" },
    ]);

    const approved = (await session.respond(answers("approve", b), asAlice)).expectOk();
    expectResolved(approved, b, "accepted");
    approved.calledTool("change-b", { status: "completed", output: { executions: 1 }, count: 1 });
    approved.notEvent("turn.started");
    approved.eventOrder([
      { type: "call.settled", data: { callId: b.call?.callId, outcome: "completed" } },
      {
        type: "content.completed",
        data: { phase: "reply", value: taskResultsReply([["change-b", "completed"]]) },
      },
      { type: "turn.settled", data: { outcome: "completed" } },
    ]);
  },
});
