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
  tags: ["hitl", "human-input", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const denied = (await session.respond(answers("cancel", request), asAlice)).expectOk();
    expectResolved(denied, request, "denied");
    expectNotRun(denied, "change-a");
    denied.event("action.result", {
      count: 1,
      data: {
        status: "rejected",
        result: {
          output: { approval: { status: "denied" }, code: "TOOL_EXECUTION_DENIED" },
          toolName: "change-a",
        },
      },
    });
    denied.event("message.completed", { data: { message: "Change A: not run." } });
    denied.event("turn.completed", { count: 1 });
  },
});
