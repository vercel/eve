import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectNotRun,
  expectResolved,
} from "../helpers.ts";

/** Alice asks for change A, then declines it: the call never runs and the model hears so. */
export default defineEval({
  description: "Denying a call resolves it as denied and records a not-run result.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const denied = (await session.respond(answers("cancel", request), asAlice)).expectOk();
    expectResolved(denied, request, "declined");
    expectNotRun(denied, "change-a");
    denied.event("call.settled", {
      count: 1,
      data: {
        callId: request.action.callId,
        cause: { interactionId: request.requestId },
        outcome: "rejected",
        output: { approval: { status: "denied" }, code: "TOOL_EXECUTION_DENIED" },
      },
    });
    denied.event("content.completed", { data: { phase: "reply", value: "Change A: not run." } });
    denied.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});
