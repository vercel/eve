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
    steered.event("input.resolved", {
      count: 1,
      data: {
        resolutions: (items) =>
          items.some((item) => item.requestId === a.requestId && item.outcome === "approved") &&
          items.some((item) => item.requestId === b.requestId && item.outcome === "ignored"),
      },
    });
    steered.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    expectNotRun(steered, "change-b");
    steered.event("action.result", {
      data: {
        result: { output: { approval: { status: "ignored" } }, toolName: "change-b" },
        status: "rejected",
      },
    });
    steered.notEvent("turn.started");
    steered.event("message.received", { count: 1, data: { message: SAY.hello } });
    // The answers resolve first. A runs in the result-reading step; Alice's
    // queued message is received by the next step of the same turn.
    steered.eventOrder([
      { type: "input.resolved" },
      { type: "step.started", data: { stepIndex: 1 } },
      { type: "action.result", data: { status: "completed", result: { toolName: "change-a" } } },
      { type: "message.received", data: { message: SAY.hello } },
      { type: "step.started", data: { stepIndex: 2 } },
      { type: "message.completed", data: { message: REPLY.hello } },
      { type: "turn.completed" },
    ]);
  },
});
